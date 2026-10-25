#!/usr/bin/env node
// Scans GitHub for pull requests you authored on repositories you don't own,
// then writes docs/contributions.json (read by the dashboard) and the board
// section of README.md. Runs on a schedule from .github/workflows/update-board.yml.
//
// Local run: GITHUB_TOKEN=$(gh auth token) node scripts/update-board.mjs

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "board.config.json");
const DATA_PATH = path.join(ROOT, "docs", "contributions.json");
const README_PATH = path.join(ROOT, "README.md");
const BOARD_START = "<!-- BOARD:START -->";
const BOARD_END = "<!-- BOARD:END -->";
const SEARCH_LIMIT = 1000; // GitHub search never returns more results than this

const STATUS_LABEL = { merged: "🔵 Merged", open: "🟢 Open", closed: "🟠 Closed" };

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
      pr.repository.stargazerCount >= (config.minStars ?? 0) &&
      (config.includeDrafts !== false || !pr.isDraft),
  );

  const pullRequests = kept.map(toPullRequest);
  const repositories = collectRepositories(kept, pullRequests);
  const content = { username, summary: summarize(pullRequests, repositories), repositories, pullRequests };

  // Only bump generatedAt when something actually changed, so unchanged runs
  // leave the working tree clean and the workflow skips the commit.
  const previous = await readJson(DATA_PATH);
  const { generatedAt: _, ...previousContent } = previous ?? {};
  const changed = JSON.stringify(previousContent) !== JSON.stringify(content);
  const data = changed ? { generatedAt: new Date().toISOString(), ...content } : previous;

  await mkdir(path.dirname(DATA_PATH), { recursive: true });
  await writeFile(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`);
  const board = renderBoard(data, config);
  await updateReadme(board);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${board}\n`);

  const { summary } = data;
  console.log(
    `${summary.pullRequests} PRs across ${summary.repositories} repos ` +
      `(${summary.merged} merged, ${summary.open} open, ${summary.closed} closed). ` +
      (changed ? "Board updated." : "No changes."),
  );
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

function renderBoard({ generatedAt, summary: s, repositories, pullRequests }, config) {
  const lines = ["<!-- Generated by scripts/update-board.mjs. Edits inside this block are overwritten. -->", ""];

  if (!pullRequests.length) {
    lines.push("_No pull requests to other repositories yet._", "");
  } else {
    lines.push(
      "| Pull requests | Merged | Open | Closed | Merge rate | Repositories | Commits | Lines changed |",
      "|---:|---:|---:|---:|---:|---:|---:|---:|",
      `| ${[
        s.pullRequests,
        s.merged,
        s.open,
        s.closed,
        s.mergeRate === null ? "–" : `${s.mergeRate}%`,
        s.repositories,
        fmt(s.commits),
        `+${fmt(s.additions)} / −${fmt(s.deletions)}`,
      ].join(" | ")} |`,
      "",
      "### Repositories",
      "",
      "| Repository | Stars | Language | PRs | Merged | Open | Closed |",
      "|---|---:|---|---:|---:|---:|---:|",
      ...Object.entries(repositories).map(
        ([name, r]) =>
          `| [${escapeMd(name)}](${r.url})${r.archived ? " _(archived)_" : ""} | ${compact(r.stars)} | ` +
          `${r.language ?? "–"} | ${r.pullRequests} | ${r.merged} | ${r.open} | ${r.closed} |`,
      ),
      "",
    );

    const active = pullRequests.filter((pr) => pr.status !== "closed");
    const closed = pullRequests.filter((pr) => pr.status === "closed");
    lines.push("### Pull requests", "");
    lines.push(active.length ? prTable(active) : "_No merged or open pull requests yet._", "");
    if (closed.length) {
      lines.push(
        "<details>",
        `<summary>Closed without merging (${closed.length})</summary>`,
        "",
        prTable(closed),
        "",
        "</details>",
        "",
      );
    }
  }

  const dashboard = config.dashboardUrl ? ` · [Interactive dashboard](${config.dashboardUrl})` : "";
  lines.push(`<sub>Last changed ${formatTimestamp(generatedAt)} · scanned daily by GitHub Actions${dashboard}</sub>`);
  return lines.join("\n");
}

function prTable(pullRequests) {
  const rows = pullRequests.map((pr) => {
    const status = pr.draft && pr.status === "open" ? "⚪ Draft" : STATUS_LABEL[pr.status];
    const landed = pr.mergedAt
      ? pr.landedCommit
        ? `[${pr.mergedAt.slice(0, 10)}](${pr.landedCommit.url})`
        : pr.mergedAt.slice(0, 10)
      : "–";
    return (
      `| ${status} | [${escapeMd(pr.title)}](${pr.url}) | ${escapeMd(pr.repo)}#${pr.number} | ${pr.commits} | ` +
      `+${fmt(pr.additions)} −${fmt(pr.deletions)} | ${pr.createdAt.slice(0, 10)} | ${landed} |`
    );
  });
  return [
    "| Status | Pull request | Repository | Commits | Changes | Opened | Merged |",
    "|---|---|---|---:|---:|---|---|",
    ...rows,
  ].join("\n");
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

const fmt = (n) => n.toLocaleString("en-US");
const compact = (n) => Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const formatTimestamp = (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
