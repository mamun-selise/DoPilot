// Pull requests and repository settings for the web app's PRs and Repo settings pages, done with this machine's
// gh login (`gh auth login`).
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { home, paths } from "./config.js";
import { board, setStage } from "./release.js";

export const PR_FIELDS = [
  "number", "title", "url", "author", "isDraft", "headRefName", "baseRefName", "createdAt", "updatedAt",
  "additions", "deletions", "changedFiles", "labels", "reviewDecision", "mergeable", "mergeStateStatus", "statusCheckRollup"
].join(",");
const MERGE_METHODS = ["merge", "squash", "rebase"];

// Repo settings the web app may change, mapped to `gh repo edit` flags. Visibility is deliberately not here.
const TEXT_FLAGS = { description: "--description", homepage: "--homepage", defaultBranch: "--default-branch" };
const SWITCH_FLAGS = {
  allowMergeCommit: "--enable-merge-commit",
  allowSquashMerge: "--enable-squash-merge",
  allowRebaseMerge: "--enable-rebase-merge",
  allowAutoMerge: "--enable-auto-merge",
  allowUpdateBranch: "--allow-update-branch",
  deleteBranchOnMerge: "--delete-branch-on-merge",
  hasIssues: "--enable-issues",
  hasWiki: "--enable-wiki",
  hasProjects: "--enable-projects",
  hasDiscussions: "--enable-discussions"
};

// Answers one request from the backend with { ok, error?, ... }; never throws, so the web app always gets a reason.
// Each request is shown in the `kora start` window: who asked, the gh command, and how it went.
export async function github(request, runner) {
  const target = request?.number ? `${request?.repo}#${request.number}` : request?.repo;
  log(`${request?.action?.endsWith("ettings") ? "Repo" : "PR"} ${request?.action} ${target} — requested by ${who(request?.from)}`);
  const started = Date.now();
  const answer = await handle(request, runner);
  const took = `(${((Date.now() - started) / 1000).toFixed(1)}s)`;
  if (!answer.ok) log(`  ✗ failed: ${answer.error} ${took}`);
  else if (answer.pullRequests) log(`  ✓ ${answer.pullRequests.length} open pull request(s) ${took}`);
  else if (request.action === "settings") log(`  ✓ settings read ${took}`);
  else if (request.action === "board") log(`  ✓ board: ${answer.board.open.length} open, ${answer.board.merged.length} merged ${took}`);
  else if (request.action === "stage") log(`  ✓ ${request.ready ? "marked ready for stage" : "moved back to open"} ${took}`);
  else if (request.action === "editSettings") log(`  ✓ ${answer.changed ? `updated: ${answer.changed}` : "nothing to change"} ${took}`);
  else log(`  ✓ ${request.action === "approve" ? "approved" : `merged (${request.method})`} ${took}`);
  return answer;
}

// Also used for requests start.js turns away before they get here.
export function log(text) {
  console.log(`[${new Date().toLocaleTimeString()}] ${text}`);
}

export function who(from) {
  return from?.email || from?.name || from?.sub || "unknown";
}

async function handle(request, runner) {
  const repo = request?.repo;
  const known = Object.values(runner.repos ?? {}).some((r) => r.github && r.github.toLowerCase() === String(repo).toLowerCase());
  if (!known) return { ok: false, error: `${repo} is not a repository in this runner's runner.yml.` };

  try {
    if (request.action === "list") {
      const out = await gh(["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", PR_FIELDS]);
      return { ok: true, pullRequests: JSON.parse(out).map(summarize) };
    }
    if (request.action === "board") return { ok: true, board: await board(repo) };
    if (request.action === "settings") return { ok: true, settings: await readSettings(repo) };
    if (request.action === "editSettings") return await editSettings(repo, request.changes ?? {});

    const number = Number(request.number);
    if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "A pull request number is required." };

    if (request.action === "stage") {
      await setStage(repo, number, Boolean(request.ready));
      return { ok: true };
    }
    if (request.action === "approve") {
      const body = typeof request.body === "string" && request.body.trim() ? ["--body", request.body.trim()] : [];
      await gh(["pr", "review", String(number), "--repo", repo, "--approve", ...body]);
      return { ok: true };
    }
    if (request.action === "merge") {
      if (!MERGE_METHODS.includes(request.method)) return { ok: false, error: "Merge method must be merge, squash or rebase." };
      await gh(["pr", "merge", String(number), "--repo", repo, `--${request.method}`, ...(request.deleteBranch ? ["--delete-branch"] : [])]);
      return { ok: true };
    }
    return { ok: false, error: `Unknown pull request action "${request.action}".` };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function readSettings(repo) {
  const r = JSON.parse(await gh(["api", `repos/${repo}`]));
  const branches = (await gh(["api", `repos/${repo}/branches`, "--paginate", "--jq", ".[].name"])).split(/\r?\n/).filter(Boolean);
  // GitHub leaves the allow_* fields out for people who cannot administer the repo; null means "not shown to you".
  const flag = (value) => (typeof value === "boolean" ? value : null);
  return {
    name: r.full_name,
    url: r.html_url,
    description: r.description ?? "",
    homepage: r.homepage ?? "",
    visibility: r.visibility,
    archived: Boolean(r.archived),
    canAdminister: Boolean(r.permissions?.admin),
    defaultBranch: r.default_branch,
    branches,
    topics: r.topics ?? [],
    allowMergeCommit: flag(r.allow_merge_commit),
    allowSquashMerge: flag(r.allow_squash_merge),
    allowRebaseMerge: flag(r.allow_rebase_merge),
    allowAutoMerge: flag(r.allow_auto_merge),
    allowUpdateBranch: flag(r.allow_update_branch),
    deleteBranchOnMerge: flag(r.delete_branch_on_merge),
    hasIssues: Boolean(r.has_issues),
    hasWiki: Boolean(r.has_wiki),
    hasProjects: Boolean(r.has_projects),
    hasDiscussions: Boolean(r.has_discussions)
  };
}

// changes holds only the fields the user changed, plus addTopics/removeTopics; answers with the settings as saved.
async function editSettings(repo, changes) {
  const args = [];
  const changed = [];
  for (const [key, flag] of Object.entries(TEXT_FLAGS)) {
    if (typeof changes[key] !== "string") continue;
    if (key === "defaultBranch" && !changes[key]) return { ok: false, error: "The default branch cannot be empty." };
    args.push(flag, changes[key]);
    changed.push(key);
  }
  for (const [key, flag] of Object.entries(SWITCH_FLAGS)) {
    if (typeof changes[key] !== "boolean") continue;
    args.push(`${flag}=${changes[key]}`);
    changed.push(key);
  }
  for (const [key, flag] of [["addTopics", "--add-topic"], ["removeTopics", "--remove-topic"]]) {
    const topics = Array.isArray(changes[key]) ? changes[key].filter((topic) => typeof topic === "string" && topic) : [];
    for (const topic of topics) args.push(flag, topic);
    if (topics.length) changed.push(`${key} ${topics.join(",")}`);
  }
  if (args.length) await gh(["repo", "edit", repo, ...args]);
  return { ok: true, changed: changed.join(", "), settings: await readSettings(repo) };
}

// ---- repositories added from the web app: GitHub only, no clone (PRs and repo settings work, tasks do not) ----

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

export async function addRepository(request, runner) {
  log(`Repo add ${request?.repo} — requested by ${who(request?.from)}`);
  let answer;
  try {
    const wanted = String(request?.repo ?? "").trim();
    if (!REPO_NAME.test(wanted)) answer = { ok: false, error: "Use owner/name, for example selise/deploy-config." };
    else if (findRepo(runner, wanted)) answer = { ok: false, error: `${wanted} is already in this runner's runner.yml.` };
    else {
      // Checks the gh account can see it, and gets GitHub's own spelling of the name.
      const github = JSON.parse(await gh(["repo", "view", wanted, "--json", "nameWithOwner"])).nameWithOwner;
      const key = uniqueKey(runner, github.split("/")[1]);
      editRunnerYml((doc) => {
        if (!YAML.isMap(doc.get("repos"))) doc.set("repos", doc.createNode({}));
        const entry = doc.createNode({ github });
        entry.flow = true; // matches the { path, github } lines kora init writes
        doc.setIn(["repos", key], entry);
      });
      runner.repos = { ...(runner.repos ?? {}), [key]: { github } };
      answer = { ok: true, key, github };
    }
  } catch (error) {
    answer = { ok: false, error: error.message };
  }
  log(answer.ok ? `  ✓ added to runner.yml as "${answer.key}" (GitHub only, no clone)` : `  ✗ failed: ${answer.error}`);
  return answer;
}

export async function removeRepository(request, runner) {
  log(`Repo remove ${request?.repo} — requested by ${who(request?.from)}`);
  let answer;
  const key = findRepo(runner, String(request?.repo ?? ""));
  if (!key) answer = { ok: false, error: `${request?.repo} is not in this runner's runner.yml.` };
  else if (runner.repos[key].path) answer = { ok: false, error: `${request.repo} is a local clone; remove it from runner.yml by hand.` };
  else {
    try {
      editRunnerYml((doc) => doc.deleteIn(["repos", key]));
      const { [key]: _removed, ...rest } = runner.repos;
      runner.repos = rest;
      answer = { ok: true, key };
    } catch (error) {
      answer = { ok: false, error: error.message };
    }
  }
  log(answer.ok ? `  ✓ removed "${answer.key}" from runner.yml` : `  ✗ failed: ${answer.error}`);
  return answer;
}

// ---- local clones added from the web app, like the FE/BE repos kora init sets up ----

// Git folders next to the clones runner.yml already has, in the home folder and in the usual code folders under it,
// that runner.yml does not list yet.
const CODE_FOLDERS = ["source/repos", "repos", "code", "projects", "src", "dev", "git", "GitHub", "Documents/GitHub", "workspace"];

export function localCandidates(runner) {
  log("Repo candidates — scanning for local clones");
  const clones = Object.values(runner.repos ?? {}).filter((repo) => repo.path).map((repo) => resolve(repo.path));
  const known = new Set(clones.map((path) => path.toLowerCase())); // Windows paths are case-insensitive
  const roots = new Set([...clones.map((path) => dirname(path)), homedir(), ...CODE_FOLDERS.map((folder) => join(homedir(), folder))]);
  const found = new Map();
  for (const root of roots) {
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(root, entry.name);
      if (known.has(path.toLowerCase()) || found.has(path.toLowerCase()) || !existsSync(join(path, ".git"))) continue;
      found.set(path.toLowerCase(), { path, github: githubRemote(path) });
      if (found.size >= 100) break;
    }
  }
  const candidates = [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
  log(`  ✓ ${candidates.length} local clone(s) found`);
  return { ok: true, candidates };
}

// Adds a clone on this machine, as kora init does. A GitHub-only entry for the same repository gets the path instead.
export async function addLocalRepository(request, runner) {
  log(`Repo add local ${request?.path} — requested by ${who(request?.from)}`);
  let answer;
  try {
    const path = resolve(String(request?.path ?? "").trim().replace(/^["']|["']$/g, ""));
    if (!request?.path || !existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Folder not found on this machine: ${path}`);
    if (!git(["-C", path, "rev-parse", "--git-dir"])) throw new Error(`Not a git repository: ${path}`);
    const same = Object.keys(runner.repos ?? {}).find((key) => runner.repos[key].path && resolve(runner.repos[key].path).toLowerCase() === path.toLowerCase());
    if (same) throw new Error(`${path} is already in runner.yml as "${same}".`);

    const github = githubRemote(path);
    const upgrade = github ? findRepo(runner, github) : null;
    if (upgrade && runner.repos[upgrade].path) throw new Error(`${github} is already in runner.yml as "${upgrade}" (${runner.repos[upgrade].path}).`);
    const wanted = String(request?.key ?? "").trim();
    if (wanted && !/^[a-z0-9][a-z0-9-]*$/.test(wanted)) throw new Error("A key uses lowercase letters, numbers and hyphens, for example fe or be.");
    if (!upgrade && wanted && runner.repos?.[wanted]) throw new Error(`The key "${wanted}" is already used in runner.yml.`);
    const key = upgrade ?? (wanted || uniqueKey(runner, basename(path)));

    const entry = github ? { path, github } : { path };
    editRunnerYml((doc) => {
      if (!YAML.isMap(doc.get("repos"))) doc.set("repos", doc.createNode({}));
      const node = doc.createNode(entry);
      node.flow = true;
      doc.setIn(["repos", key], node);
    });
    runner.repos = { ...(runner.repos ?? {}), [key]: entry };
    answer = { ok: true, key, github, path, upgraded: Boolean(upgrade) };
  } catch (error) {
    answer = { ok: false, error: error.message };
  }
  log(answer.ok
    ? `  ✓ ${answer.upgraded ? "linked the clone to" : "added"} "${answer.key}": ${answer.path}${answer.github ? ` (${answer.github})` : " (no GitHub remote)"}`
    : `  ✗ failed: ${answer.error}`);
  return answer;
}

// Same rule kora init uses: the origin remote, when it points at GitHub.
function githubRemote(path) {
  return git(["-C", path, "remote", "get-url", "origin"])?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? null;
}

// No shell: paths come from the web app.
function git(args) {
  try {
    return execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function findRepo(runner, github) {
  return Object.keys(runner.repos ?? {}).find((key) => runner.repos[key]?.github?.toLowerCase() === github.toLowerCase());
}

function uniqueKey(runner, name) {
  const base = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "repo";
  let key = base;
  for (let n = 2; runner.repos?.[key]; n++) key = `${base}-${n}`;
  return key;
}

// Edits runner.yml as a YAML document, so the comments kora init wrote stay put.
function editRunnerYml(change) {
  const doc = YAML.parseDocument(readFileSync(paths.runner, "utf8"));
  change(doc);
  writeFileSync(paths.runner, doc.toString());
}

// No shell, so titles and review text never reach a command line. Runs in KORA's home, not a clone: with
// --delete-branch, gh would otherwise switch and delete branches in whatever repository it was started in.
// quiet: leave the command out of the kora start window (polling); timeout: for long waits such as gh pr checks --watch.
export function gh(args, { quiet = false, timeout = 45_000 } = {}) {
  if (!quiet) log(`  $ gh ${args.map((arg) => (arg === PR_FIELDS ? "<fields>" : /[\s"]/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`);
  mkdirSync(home, { recursive: true });
  return new Promise((resolve, reject) => {
    execFile("gh", args, { cwd: home, timeout, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      if (error.code === "ENOENT") return reject(new Error("GitHub CLI (gh) is not installed on this runner."));
      reject(new Error(stderr.trim() || error.message));
    });
  });
}

export function summarize(pr) {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author?.login ?? null,
    isDraft: Boolean(pr.isDraft),
    head: pr.headRefName,
    base: pr.baseRefName,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changedFiles ?? 0,
    labels: (pr.labels ?? []).map((label) => label.name),
    reviewDecision: pr.reviewDecision || null,
    mergeable: pr.mergeable || null,
    mergeState: pr.mergeStateStatus || null,
    checks: checks(pr.statusCheckRollup ?? [])
  };
}

// statusCheckRollup mixes check runs (status + conclusion) and commit statuses (state).
function checks(rollup) {
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const check of rollup) {
    const state = check.__typename === "StatusContext" ? check.state : check.status !== "COMPLETED" ? "PENDING" : check.conclusion;
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state)) counts.passed++;
    else if (["PENDING", "EXPECTED"].includes(state)) counts.pending++;
    else counts.failed++;
  }
  return counts;
}
