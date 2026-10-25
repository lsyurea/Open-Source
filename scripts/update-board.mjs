#!/usr/bin/env node
// Scans GitHub for pull requests you authored on repositories you don't own,
// then renders an SVG summary card and the board section of a README.
//
// Two layouts, chosen with BOARD_LAYOUT:
//   full    (default) README card + PR table, docs/contributions.json for the dashboard
//   profile README card only, for a github.com/<you> profile repo
// BOARD_ROOT points at the repo to write into (defaults to this repo); its
// board.config.json wins over the one next to this script.
//
// Local run: GITHUB_TOKEN=$(gh auth token) node scripts/update-board.mjs

import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(process.env.BOARD_ROOT || TOOL_ROOT);
const LAYOUTS = {
  full: { data: "docs/contributions.json", cards: { light: "docs/charts/card-light.svg", dark: "docs/charts/card-dark.svg" } },
  profile: { data: null, cards: { dark: "assets/open-source.svg" } },
};
const LAYOUT_NAME = process.env.BOARD_LAYOUT || "full";
const LAYOUT = LAYOUTS[LAYOUT_NAME];
const README_PATH = path.join(ROOT, "README.md");
const BOARD_START = "<!-- BOARD:START -->";
const BOARD_END = "<!-- BOARD:END -->";
const SEARCH_LIMIT = 1000; // GitHub search never returns more results than this

const STATUS_ORDER = ["merged", "open", "closed"];
const STATUS = {
  merged: { name: "Merged", emoji: "🔵" },
  open: { name: "Open", emoji: "🟢" },
  closed: { name: "Closed", emoji: "🟠" },
};

// Card chrome follows GitHub's own light/dark UI so it sits naturally in a
// README; series colors match docs/index.html.
const CARD_THEMES = {
  light: {
    bg: "#ffffff", border: "#d1d9e0", title: "#0969da", ink: "#1f2328", text: "#59636e",
    add: "#1a7f37", del: "#d1242f", merged: "#2a78d6", open: "#1baf7a", closed: "#eb6834",
  },
  dark: {
    bg: "#0d1117", border: "#30363d", title: "#58a6ff", ink: "#e6edf3", text: "#8b949e",
    add: "#3fb950", del: "#f85149", merged: "#3987e5", open: "#199e70", closed: "#d95926",
  },
};
const CARD = { width: 700, pad: 28, repos: 5, pullRequests: 3 };

const PR_QUERY = `
query ($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        title
        url
        state
        isDraft
        merged
        createdAt
        mergedAt
        closedAt
        additions
        deletions
        changedFiles
        commits { totalCount }
        mergeCommit { oid url }
        timelineItems(itemTypes: [CLOSED_EVENT], last: 1) {
          nodes { ... on ClosedEvent { closer { __typename ... on Commit { oid url } } } }
        }
        repository {
          nameWithOwner
          url
          description
          stargazerCount
          isArchived
          owner { login avatarUrl }
          primaryLanguage { name color }
        }
      }
    }
  }
}`;

async function main() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    throw new Error("Set GITHUB_TOKEN, e.g. GITHUB_TOKEN=$(gh auth token) node scripts/update-board.mjs");
  }
  if (!LAYOUT) throw new Error(`Unknown BOARD_LAYOUT "${LAYOUT_NAME}"; use ${Object.keys(LAYOUTS).join(" or ")}`);

  const config = await loadConfig();
  const username = config.username || process.env.GITHUB_REPOSITORY_OWNER;
  if (!username) throw new Error('Set "username" in board.config.json');
  const minStars = config.minStars ?? 0;

  // -user: drops repos you own (including your forks); is:public keeps local
  // runs consistent with the Actions token, which can't see private repos.
  const query = `is:pr is:public author:${username} -user:${username} sort:created-desc`;
  const nodes = await searchPullRequests(token, query);

  const excludedOwners = new Set((config.excludeOwners ?? []).map((s) => s.toLowerCase()));
  const excludedRepos = new Set((config.excludeRepos ?? []).map((s) => s.toLowerCase()));
  const kept = nodes.filter(
    (pr) =>
      pr?.repository &&
      !excludedOwners.has(pr.repository.owner.login.toLowerCase()) &&
      !excludedRepos.has(pr.repository.nameWithOwner.toLowerCase()) &&
      pr.repository.stargazerCount >= minStars &&
      (config.includeDrafts !== false || !pr.isDraft),
  );

  const pullRequests = kept.map(toPullRequest);
  const repositories = collectRepositories(kept, pullRequests);
  const content = { username, minStars, summary: summarize(pullRequests, repositories), repositories, pullRequests };

  // Only bump generatedAt when something actually changed, so unchanged runs
  // leave the working tree clean and the workflow skips the commit.
  const dataPath = LAYOUT.data && path.join(ROOT, LAYOUT.data);
  const previous = dataPath ? await readJson(dataPath) : null;
  const { generatedAt: _, ...previousContent } = previous ?? {};
  const changed = JSON.stringify(previousContent) !== JSON.stringify(content);
  const data = changed ? { generatedAt: new Date().toISOString(), ...content } : previous;

  if (dataPath) await writeOutput(dataPath, `${JSON.stringify(data, null, 2)}\n`);
  const avatars = await fetchAvatars(Object.entries(data.repositories).slice(0, CARD.repos));
  for (const [theme, file] of Object.entries(LAYOUT.cards)) {
    await writeOutput(path.join(ROOT, file), renderCard(data, CARD_THEMES[theme], avatars));
  }
  await updateReadme(LAYOUT_NAME === "profile" ? renderProfileBoard(data, config) : renderBoard(data, config));

  const { summary } = data;
  const report =
    `${summary.pullRequests} PRs across ${summary.repositories} repos with ${minStars}+ stars ` +
    `(${summary.merged} merged, ${summary.open} open, ${summary.closed} closed; ` +
    `${nodes.length - kept.length} filtered out). ` +
    (dataPath && !changed ? "No changes." : "Board rendered.");
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
}

async function loadConfig() {
  for (const dir of [ROOT, TOOL_ROOT]) {
    const file = path.join(dir, "board.config.json");
    const exists = await access(file).then(() => true, () => false);
    if (exists) return JSON.parse(await readFile(file, "utf8"));
  }
  throw new Error("board.config.json not found");
}

async function searchPullRequests(token, q) {
  const nodes = [];
  let cursor = null;
  do {
    const { search } = await graphql(token, PR_QUERY, { q, cursor });
    if (!cursor && search.issueCount > SEARCH_LIMIT) {
      console.warn(`Search matched ${search.issueCount} PRs; GitHub only returns the newest ${SEARCH_LIMIT}.`);
    }
    nodes.push(...search.nodes);
    cursor = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null;
  } while (cursor);
  return nodes;
}

async function graphql(token, query, variables, attempt = 1) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "open-source-board",
    },
    body: JSON.stringify({ query, variables }),
  });
  // GitHub's search endpoint intermittently returns 502s; back off and retry.
  if (res.status >= 500 && attempt < 4) {
    await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    return graphql(token, query, variables, attempt + 1);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.data) {
    throw new Error(`GitHub GraphQL request failed (${res.status}): ${JSON.stringify(body?.errors ?? body)}`);
  }
  // Partial errors (e.g. a repo that became inaccessible) null out single nodes;
  // keep the rest of the page.
  for (const error of body.errors ?? []) console.warn(`GraphQL warning: ${error.message}`);
  return body.data;
}

function toPullRequest(pr) {
  // Some projects (PyTorch, for one) land a PR as a bot commit on the default
  // branch and then close it, so GitHub reports it as closed, not merged.
  const closer = pr.timelineItems.nodes[0]?.closer;
  const closedByCommit = pr.state === "CLOSED" && closer?.__typename === "Commit" ? closer : null;
  const landedCommit = pr.merged ? pr.mergeCommit : closedByCommit;
  const merged = pr.merged || Boolean(closedByCommit);
  return {
    repo: pr.repository.nameWithOwner,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    status: pr.state === "OPEN" ? "open" : merged ? "merged" : "closed",
    draft: pr.isDraft,
    createdAt: pr.createdAt,
    mergedAt: merged ? (pr.mergedAt ?? pr.closedAt) : null,
    closedAt: pr.closedAt,
    commits: pr.commits.totalCount,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    landedCommit: landedCommit ? { sha: landedCommit.oid, url: landedCommit.url } : null,
  };
}

function collectRepositories(nodes, pullRequests) {
  const repos = new Map();
  for (const { repository: r } of nodes) {
    if (repos.has(r.nameWithOwner)) continue;
    repos.set(r.nameWithOwner, {
      url: r.url,
      description: r.description,
      stars: r.stargazerCount,
      language: r.primaryLanguage?.name ?? null,
      languageColor: r.primaryLanguage?.color ?? null,
      avatarUrl: r.owner.avatarUrl,
      archived: r.isArchived,
      pullRequests: 0,
      merged: 0,
      open: 0,
      closed: 0,
    });
  }
  for (const pr of pullRequests) {
    const repo = repos.get(pr.repo);
    repo.pullRequests++;
    repo[pr.status]++;
  }
  const ranked = [...repos].sort(
    ([nameA, a], [nameB, b]) => b.stars - a.stars || b.pullRequests - a.pullRequests || nameA.localeCompare(nameB),
  );
  return Object.fromEntries(ranked);
}

function summarize(pullRequests, repositories) {
  const total = (pick) => pullRequests.reduce((sum, pr) => sum + pick(pr), 0);
  const count = (status) => total((pr) => (pr.status === status ? 1 : 0));
  const merged = count("merged");
  const closed = count("closed");
  return {
    pullRequests: pullRequests.length,
    merged,
    open: count("open"),
    closed,
    mergeRate: merged + closed ? Math.round((merged / (merged + closed)) * 100) : null,
    repositories: Object.keys(repositories).length,
    commits: total((pr) => pr.commits),
    additions: total((pr) => pr.additions),
    deletions: total((pr) => pr.deletions),
  };
}

function renderBoard({ generatedAt, pullRequests, ...data }, config) {
  const { light, dark } = LAYOUT.cards;
  const card =
    `<picture><source media="(prefers-color-scheme: dark)" srcset="${dark}">` +
    `<img alt="${escapeXml(cardAlt(data))}" src="${light}"></picture>`;
  const lines = [
    "<!-- Generated by scripts/update-board.mjs. Edits inside this block are overwritten. -->",
    "",
    config.dashboardUrl ? `<a href="${config.dashboardUrl}">${card}</a>` : card,
  ];
  if (pullRequests.length) {
    lines.push(
      "",
      "| Status | Pull request | Repository | Changes | Landed |",
      "|---|---|---|---:|---|",
      ...pullRequests.map(prRow),
    );
  }
  const dashboard = config.dashboardUrl ? ` · [Dashboard](${config.dashboardUrl})` : "";
  lines.push("", `<sub>Updated ${formatTimestamp(generatedAt)}${dashboard}</sub>`);
  return lines.join("\n");
}

// No timestamp here: the profile repo keeps no data file, so the output must
// be identical across runs unless the contributions themselves change.
function renderProfileBoard(data, config) {
  const img = `<img src="${LAYOUT.cards.dark}" alt="${escapeXml(cardAlt(data))}" />`;
  return config.dashboardUrl ? `<a href="${config.dashboardUrl}">${img}</a>` : img;
}

function cardAlt({ minStars, summary: s }) {
  const scope = minStars ? ` with ${compact(minStars)}+ stars` : "";
  return `Open source contributions: ${s.merged} merged PRs across ${s.repositories} ${plural(s.repositories, "repo")}${scope}`;
}

function prRow(pr) {
  const { name, emoji } = pr.draft && pr.status === "open" ? { name: "Draft", emoji: "⚪" } : STATUS[pr.status];
  const date = pr.mergedAt?.slice(0, 10);
  const landed = !date ? "–" : pr.landedCommit ? `[${date}](${pr.landedCommit.url})` : date;
  return (
    `| ${emoji} ${name} | [${escapeMd(pr.title)}](${pr.url}) | ${escapeMd(pr.repo)}#${pr.number} | ` +
    `+${fmt(pr.additions)} −${fmt(pr.deletions)} | ${landed} |`
  );
}

// SVG served through <img> can't load external URLs, so owner avatars are
// inlined as data URIs. A failed fetch falls back to an initial in the card.
async function fetchAvatars(entries) {
  const avatars = new Map();
  for (const [name, repo] of entries) {
    try {
      const url = new URL(repo.avatarUrl);
      url.searchParams.set("s", "48");
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get("content-type") ?? "image/png";
      avatars.set(name, `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`);
    } catch (error) {
      console.warn(`Avatar for ${name} unavailable: ${error.message}`);
    }
  }
  return avatars;
}

function renderCard({ minStars, summary: s, repositories, pullRequests }, theme, avatars) {
  const { width, pad } = CARD;
  const right = width - pad;
  const defs = [];
  const body = [];
  const divider = (y) => body.push(`<line x1="${pad}" x2="${right}" y1="${y + 0.5}" y2="${y + 0.5}" stroke="${theme.border}"/>`);
  const heading = (y, label) => body.push(svgText(pad, y, label, { fill: theme.ink, "font-size": 13, "font-weight": 600 }));

  body.push(svgText(pad, 46, "Open Source Contributions", { fill: theme.title, "font-size": 20, "font-weight": 600 }));
  body.push(svgText(right, 46, minStars ? `Repos with ${compact(minStars)}+ ★` : "All public repos", { fill: theme.text, "font-size": 12, "text-anchor": "end" }));

  // Headline figures
  const stats = [
    [fmt(s.merged), "Merged PRs"],
    [fmt(s.repositories), s.repositories === 1 ? "Repository" : "Repositories"],
    [compact(s.commits), "Commits"],
    [null, "Lines changed"],
  ];
  const colW = (width - pad * 2) / stats.length;
  stats.forEach(([value, label], i) => {
    const x = pad + i * colW;
    body.push(
      value === null
        ? `<text x="${round(x)}" y="102" font-size="28" font-weight="600"><tspan fill="${theme.add}">+${compact(s.additions)}</tspan>` +
            `<tspan dx="6" font-size="16" fill="${theme.del}">−${compact(s.deletions)}</tspan></text>`
        : svgText(x, 102, value, { fill: theme.ink, "font-size": 28, "font-weight": 600 }),
    );
    body.push(svgText(x, 124, label, { fill: theme.text, "font-size": 12 }));
  });
  divider(148);

  // Activity: last 12 months by month opened, stacked by current status
  heading(178, "Pull requests per month");
  const legendItems = STATUS_ORDER.map((status) => ({ status, w: 16 + textWidth(STATUS[status].name, 12) }));
  let lx = right - legendItems.reduce((sum, item) => sum + item.w, 0) - 14 * (legendItems.length - 1);
  for (const { status, w } of legendItems) {
    body.push(`<rect x="${round(lx)}" y="169" width="10" height="10" rx="3" fill="${theme[status]}"/>`);
    body.push(svgText(lx + 16, 178, STATUS[status].name, { fill: theme.text, "font-size": 12 }));
    lx += w + 14;
  }
  const { months, counts, totals } = monthlyActivity(pullRequests);
  const chartTop = 200;
  const baseline = 272;
  const scale = (baseline - chartTop - 16) / Math.max(1, ...totals); // leave room for the cap label
  const band = (width - pad * 2) / months.length;
  const barW = 20;
  body.push(`<line x1="${pad}" x2="${right}" y1="${baseline + 0.5}" y2="${baseline + 0.5}" stroke="${theme.border}"/>`);
  months.forEach((month, i) => {
    const cx = pad + i * band + band / 2;
    body.push(...stackSegments(counts[i], scale, theme, (start, size) => ({ x: cx - barW / 2, y: baseline - start - size, w: barW, h: size }), "top"));
    if (totals[i]) {
      body.push(svgText(cx, baseline - totals[i] * scale - 6, totals[i], { fill: theme.text, "font-size": 12, "text-anchor": "middle" }));
    }
    const year = i === 0 || month.getUTCMonth() === 0 ? ` ’${String(month.getUTCFullYear()).slice(2)}` : "";
    body.push(svgText(cx, baseline + 18, monthName(month) + year, { fill: theme.text, "font-size": 11, "text-anchor": "middle" }));
  });
  if (!totals.some(Boolean)) {
    body.push(svgText(width / 2, (chartTop + baseline) / 2, "No pull requests in the last 12 months", { fill: theme.text, "font-size": 12, "text-anchor": "middle" }));
  }
  divider(304);

  // Repositories, ranked by stars
  heading(334, "Repositories");
  const repoEntries = Object.entries(repositories);
  const shownRepos = repoEntries.slice(0, CARD.repos);
  const barX = 540;
  const barScale = (right - 28 - barX) / Math.max(1, ...shownRepos.map(([, r]) => r.pullRequests));
  let y = 348;
  shownRepos.forEach(([name, repo], i) => {
    const cy = y + 18;
    const avatar = avatars.get(name);
    defs.push(`<clipPath id="avatar-${i}"><rect x="${pad}" y="${cy - 12}" width="24" height="24" rx="6"/></clipPath>`);
    body.push(
      avatar
        ? `<image href="${avatar}" x="${pad}" y="${cy - 12}" width="24" height="24" clip-path="url(#avatar-${i})"/>`
        : `<rect x="${pad}" y="${cy - 12}" width="24" height="24" rx="6" fill="${theme.border}"/>` +
            svgText(pad + 12, cy + 4, name[0].toUpperCase(), { fill: theme.ink, "font-size": 12, "font-weight": 600, "text-anchor": "middle" }),
    );
    body.push(svgText(pad + 36, cy + 4, truncate(name, 300, 13), { fill: theme.ink, "font-size": 13, "font-weight": 500 }));
    body.push(svgText(430, cy + 4, `★ ${compact(repo.stars)}`, { fill: theme.text, "font-size": 12, "text-anchor": "end" }));
    if (repo.language) {
      body.push(`<circle cx="450" cy="${cy}" r="4" fill="${repo.languageColor ?? theme.text}"/>`);
      body.push(svgText(460, cy + 4, truncate(repo.language, 72, 12), { fill: theme.text, "font-size": 12 }));
    }
    body.push(...stackSegments(repo, barScale, theme, (start, size) => ({ x: barX + start, y: cy - 4, w: size, h: 8 }), "right"));
    body.push(svgText(barX + repo.pullRequests * barScale + 8, cy + 4, repo.pullRequests, { fill: theme.text, "font-size": 12 }));
    y += 36;
  });
  if (!shownRepos.length) {
    body.push(svgText(pad, y + 22, "No contributions yet", { fill: theme.text, "font-size": 12 }));
    y += 36;
  }
  if (repoEntries.length > shownRepos.length) {
    body.push(svgText(pad + 36, y + 14, `+${repoEntries.length - shownRepos.length} more`, { fill: theme.text, "font-size": 12 }));
    y += 24;
  }

  // Latest pull requests
  const latest = pullRequests.slice(0, CARD.pullRequests);
  if (latest.length) {
    y += 8;
    divider(y);
    heading(y + 30, "Latest pull requests");
    y += 44;
    for (const pr of latest) {
      const cy = y + 15;
      const draft = pr.draft && pr.status === "open";
      body.push(
        draft
          ? `<circle cx="${pad + 4}" cy="${cy}" r="3.5" fill="none" stroke="${theme.open}" stroke-width="1.5"/>`
          : `<circle cx="${pad + 4}" cy="${cy}" r="4" fill="${theme[pr.status]}"/>`,
      );
      const meta = `${pr.repo} · ${shortDate(pr.mergedAt ?? pr.createdAt)}`;
      body.push(svgText(right, cy + 4, meta, { fill: theme.text, "font-size": 12, "text-anchor": "end" }));
      const titleRoom = right - textWidth(meta, 12) - 24 - (pad + 16);
      body.push(svgText(pad + 16, cy + 4, truncate(pr.title, titleRoom, 13), { fill: theme.ink, "font-size": 13 }));
      y += 30;
    }
  }

  const height = y + 22;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" ` +
    `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif">\n` +
    `<title>${escapeXml(cardAlt({ minStars, summary: s }))}</title>\n` +
    (defs.length ? `<defs>${defs.join("")}</defs>\n` : "") +
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="${theme.bg}" stroke="${theme.border}"/>\n` +
    `${body.join("\n")}\n</svg>\n`
  );
}

function monthlyActivity(pullRequests) {
  const now = new Date();
  const months = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1)));
  const index = new Map(months.map((d, i) => [d.toISOString().slice(0, 7), i]));
  const counts = months.map(() => ({ merged: 0, open: 0, closed: 0 }));
  for (const pr of pullRequests) {
    const i = index.get(pr.createdAt.slice(0, 7));
    if (i !== undefined) counts[i][pr.status]++;
  }
  return { months, counts, totals: counts.map((c) => c.merged + c.open + c.closed) };
}

// Lays out status segments end to end with a 2px gap between them; only the
// outermost segment gets the 4px rounded data-end.
function stackSegments(counts, scale, theme, place, roundedSide) {
  const present = STATUS_ORDER.filter((status) => counts[status] > 0);
  const marks = [];
  let start = 0;
  present.forEach((status, i) => {
    const gap = i > 0 ? 2 : 0;
    const { x, y, w, h } = place(start * scale + gap, counts[status] * scale - gap);
    const fill = theme[status];
    marks.push(
      i === present.length - 1
        ? `<path d="${roundedRect(x, y, w, h, 4, roundedSide)}" fill="${fill}"/>`
        : `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" fill="${fill}"/>`,
    );
    start += counts[status];
  });
  return marks;
}

function roundedRect(x, y, w, h, r, side) {
  r = Math.min(r, w / 2, h / 2);
  const [X, Y, W, H, R] = [x, y, w, h, r].map(round);
  return side === "top"
    ? `M${X},${Y + H}V${Y + R}A${R},${R} 0 0 1 ${X + R},${Y}H${X + W - R}A${R},${R} 0 0 1 ${X + W},${Y + R}V${Y + H}Z`
    : `M${X},${Y}H${X + W - R}A${R},${R} 0 0 1 ${X + W},${Y + R}V${Y + H - R}A${R},${R} 0 0 1 ${X + W - R},${Y + H}H${X}Z`;
}

function svgText(x, y, content, attrs) {
  const extra = Object.entries(attrs).map(([key, value]) => ` ${key}="${value}"`).join("");
  return `<text x="${round(x)}" y="${round(y)}"${extra}>${escapeXml(String(content))}</text>`;
}

// SVG text can't be measured server-side, so estimate per glyph class for
// GitHub's system font stack (slightly generous to avoid overlaps).
function glyphWidth(ch) {
  if (/[il.,:;'|!Ijft()[\] ]/.test(ch)) return 0.32;
  if (/[mwMW@]/.test(ch)) return 0.86;
  if (/[A-Z0-9#%&_]/.test(ch)) return 0.66;
  return 0.55;
}

const textWidth = (text, fontSize) => [...text].reduce((sum, ch) => sum + glyphWidth(ch), 0) * fontSize;

function truncate(text, maxWidth, fontSize) {
  if (textWidth(text, fontSize) <= maxWidth) return text;
  let width = textWidth("…", fontSize);
  let out = "";
  for (const ch of text) {
    width += glyphWidth(ch) * fontSize;
    if (width > maxWidth) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

async function writeOutput(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

async function updateReadme(board) {
  const block = `${BOARD_START}\n${board}\n${BOARD_END}`;
  let readme = await readFile(README_PATH, "utf8").catch(() => "# Open Source Contributions\n");
  const start = readme.indexOf(BOARD_START);
  const end = readme.indexOf(BOARD_END);
  readme =
    start === -1 || end === -1
      ? `${readme.trimEnd()}\n\n${block}\n`
      : readme.slice(0, start) + block + readme.slice(end + BOARD_END.length);
  await writeFile(README_PATH, readme);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function escapeMd(text) {
  return text.replace(/[\\|[\]*_`<>]/g, (ch) => (ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : `\\${ch}`));
}

function escapeXml(text) {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]);
}

const round = (n) => Math.round(n * 10) / 10;
const plural = (n, word) => (n === 1 ? word : `${word}s`);
const fmt = (n) => n.toLocaleString("en-US");
const compact = (n) => Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const monthName = (d) => d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
const shortDate = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const formatTimestamp = (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
