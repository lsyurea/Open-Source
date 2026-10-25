#!/usr/bin/env node
// Scans GitHub for pull requests you authored on repositories you don't own,
// then writes docs/contributions.json (read by the dashboard), SVG charts in
// docs/charts/, and the board section of README.md. Runs on a schedule from
// .github/workflows/update-board.yml.
//
// Local run: GITHUB_TOKEN=$(gh auth token) node scripts/update-board.mjs

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "board.config.json");
const DATA_PATH = path.join(ROOT, "docs", "contributions.json");
const CHARTS_DIR = path.join(ROOT, "docs", "charts");
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

// Same palette as docs/index.html; GitHub picks the variant matching the viewer's theme.
const CHART_THEMES = {
  light: { ink: "#0b0b0b", ink2: "#52514e", muted: "#898781", axis: "#c3c2b7", merged: "#2a78d6", open: "#1baf7a", closed: "#eb6834" },
  dark: { ink: "#f0efec", ink2: "#c3c2b7", muted: "#898781", axis: "#383835", merged: "#3987e5", open: "#199e70", closed: "#d95926" },
};

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

  const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
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
  const previous = await readJson(DATA_PATH);
  const { generatedAt: _, ...previousContent } = previous ?? {};
  const changed = JSON.stringify(previousContent) !== JSON.stringify(content);
  const data = changed ? { generatedAt: new Date().toISOString(), ...content } : previous;

  await mkdir(path.dirname(DATA_PATH), { recursive: true });
  await writeFile(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`);
  await writeCharts(data);
  await updateReadme(renderBoard(data, config));

  const { summary } = data;
  const report =
    `${summary.pullRequests} PRs across ${summary.repositories} repos with ${minStars}+ stars ` +
    `(${summary.merged} merged, ${summary.open} open, ${summary.closed} closed; ` +
    `${nodes.length - kept.length} filtered out). ` +
    (changed ? "Board updated." : "No changes.");
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
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

function renderBoard({ generatedAt, minStars, summary: s, pullRequests }, config) {
  const scope = minStars ? `Repos with ${compact(minStars)}+ stars` : "All repos";
  const lines = ["<!-- Generated by scripts/update-board.mjs. Edits inside this block are overwritten. -->", ""];

  if (!pullRequests.length) {
    lines.push(`_${scope}: no pull requests yet._`);
  } else {
    lines.push(
      `${scope} · **${s.merged}** merged · **${s.open}** open · **${s.closed}** closed · ` +
        `**${s.repositories}** ${s.repositories === 1 ? "repo" : "repos"} · **+${fmt(s.additions)} −${fmt(s.deletions)}** lines`,
      "",
      chartImage("activity", "Pull requests per month"),
      "",
      chartImage("repos", "Pull requests by repository"),
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

function chartImage(name, alt) {
  return (
    `<picture><source media="(prefers-color-scheme: dark)" srcset="docs/charts/${name}-dark.svg">` +
    `<img alt="${alt}" src="docs/charts/${name}-light.svg"></picture>`
  );
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

async function writeCharts({ pullRequests, repositories }) {
  await mkdir(CHARTS_DIR, { recursive: true });
  for (const [mode, theme] of Object.entries(CHART_THEMES)) {
    await writeFile(path.join(CHARTS_DIR, `activity-${mode}.svg`), activityChart(pullRequests, theme));
    await writeFile(path.join(CHARTS_DIR, `repos-${mode}.svg`), reposChart(repositories, theme));
  }
}

// Last 12 months of PRs by month opened, stacked by current status.
function activityChart(pullRequests, theme) {
  const width = 800;
  const height = 210;
  const top = 64;
  const baseline = height - 24;
  const now = new Date();
  const months = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1)));
  const counts = new Map(months.map((d) => [d.toISOString().slice(0, 7), { merged: 0, open: 0, closed: 0 }]));
  for (const pr of pullRequests) {
    const bucket = counts.get(pr.createdAt.slice(0, 7));
    if (bucket) bucket[pr.status]++;
  }
  const totals = [...counts.values()].map((c) => c.merged + c.open + c.closed);
  const scale = (baseline - top - 18) / Math.max(1, ...totals); // leave room for the cap label
  const band = width / months.length;
  const barW = 24;

  const body = chartHeader("Pull requests per month", theme);
  body.push(`<line x1="0" x2="${width}" y1="${baseline + 0.5}" y2="${baseline + 0.5}" stroke="${theme.axis}"/>`);
  months.forEach((month, i) => {
    const c = counts.get(month.toISOString().slice(0, 7));
    const cx = i * band + band / 2;
    body.push(...stackSegments(c, scale, theme, (start, size) => ({ x: cx - barW / 2, y: baseline - start - size, w: barW, h: size }), "top"));
    if (totals[i]) {
      body.push(svgText(cx, baseline - totals[i] * scale - 6, totals[i], { fill: theme.ink2, "font-size": 12, "text-anchor": "middle" }));
    }
    const label = month.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    const year = i === 0 || month.getUTCMonth() === 0 ? ` ’${String(month.getUTCFullYear()).slice(2)}` : "";
    body.push(svgText(cx, height - 6, label + year, { fill: theme.muted, "font-size": 11, "text-anchor": "middle" }));
  });
  if (!totals.some(Boolean)) {
    body.push(svgText(width / 2, (top + baseline) / 2, "No pull requests in the last 12 months", { fill: theme.muted, "font-size": 12, "text-anchor": "middle" }));
  }
  return svgDoc(width, height, body);
}

// PR count per repository (top 10 by stars), stacked by status.
function reposChart(repositories, theme) {
  const entries = Object.entries(repositories).slice(0, 10);
  const width = 800;
  const top = 60;
  const rowH = 32;
  const labelW = 250;
  const barH = 14;
  const height = top + Math.max(1, entries.length) * rowH;
  const scale = (width - labelW - 40) / Math.max(1, ...entries.map(([, r]) => r.pullRequests));

  const body = chartHeader("Pull requests by repository", theme);
  entries.forEach(([name, repo], i) => {
    const cy = top + i * rowH + rowH / 2;
    const label = name.length > 26 ? `${name.slice(0, 25)}…` : name;
    body.push(svgText(0, cy + 4, label, { fill: theme.ink, "font-size": 13 }));
    body.push(svgText(labelW - 16, cy + 4, `★ ${compact(repo.stars)}`, { fill: theme.muted, "font-size": 12, "text-anchor": "end" }));
    body.push(...stackSegments(repo, scale, theme, (start, size) => ({ x: labelW + start, y: cy - barH / 2, w: size, h: barH }), "right"));
    body.push(svgText(labelW + repo.pullRequests * scale + 8, cy + 4, repo.pullRequests, { fill: theme.ink2, "font-size": 12 }));
  });
  return svgDoc(width, height, body);
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

function chartHeader(title, theme) {
  const parts = [svgText(0, 18, title, { fill: theme.ink, "font-size": 14, "font-weight": 600 })];
  let x = 0;
  for (const status of STATUS_ORDER) {
    const { name } = STATUS[status];
    parts.push(`<rect x="${x}" y="32" width="10" height="10" rx="3" fill="${theme[status]}"/>`);
    parts.push(svgText(x + 16, 41, name, { fill: theme.ink2, "font-size": 12 }));
    x += 16 + name.length * 7 + 18;
  }
  return parts;
}

function svgDoc(width, height, body) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ` +
    `font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">\n${body.join("\n")}\n</svg>\n`
  );
}

function svgText(x, y, content, attrs) {
  const extra = Object.entries(attrs).map(([key, value]) => ` ${key}="${value}"`).join("");
  return `<text x="${round(x)}" y="${round(y)}"${extra}>${escapeXml(String(content))}</text>`;
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
const fmt = (n) => n.toLocaleString("en-US");
const compact = (n) => Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const formatTimestamp = (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
