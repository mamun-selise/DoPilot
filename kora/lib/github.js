// Pull requests for the web app's PRs page, done with this machine's gh login (`gh auth login`).
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { home } from "./config.js";

const PR_FIELDS = [
  "number", "title", "url", "author", "isDraft", "headRefName", "baseRefName", "createdAt", "updatedAt",
  "additions", "deletions", "changedFiles", "labels", "reviewDecision", "mergeable", "mergeStateStatus", "statusCheckRollup"
].join(",");
const MERGE_METHODS = ["merge", "squash", "rebase"];

// Answers one request from the backend with { ok, error?, ... }; never throws, so the web app always gets a reason.
export async function github(request, runner) {
  const repo = request?.repo;
  const known = Object.values(runner.repos ?? {}).some((r) => r.github && r.github.toLowerCase() === String(repo).toLowerCase());
  if (!known) return { ok: false, error: `${repo} is not a repository in this runner's runner.yml.` };

  try {
    if (request.action === "list") {
      const out = await gh(["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", PR_FIELDS]);
      return { ok: true, pullRequests: JSON.parse(out).map(summarize) };
    }

    const number = Number(request.number);
    if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "A pull request number is required." };

    if (request.action === "approve") {
      const body = typeof request.body === "string" && request.body.trim() ? ["--body", request.body.trim()] : [];
      await gh(["pr", "review", String(number), "--repo", repo, "--approve", ...body]);
      console.log(`Approved ${repo}#${number} for ${request.from?.email || request.from?.sub}.`);
      return { ok: true };
    }
    if (request.action === "merge") {
      if (!MERGE_METHODS.includes(request.method)) return { ok: false, error: "Merge method must be merge, squash or rebase." };
      await gh(["pr", "merge", String(number), "--repo", repo, `--${request.method}`, ...(request.deleteBranch ? ["--delete-branch"] : [])]);
      console.log(`Merged ${repo}#${number} (${request.method}) for ${request.from?.email || request.from?.sub}.`);
      return { ok: true };
    }
    return { ok: false, error: `Unknown pull request action "${request.action}".` };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// No shell, so titles and review text never reach a command line. Runs in KORA's home, not a clone: with
// --delete-branch, gh would otherwise switch and delete branches in whatever repository it was started in.
function gh(args) {
  mkdirSync(home, { recursive: true });
  return new Promise((resolve, reject) => {
    execFile("gh", args, { cwd: home, timeout: 45_000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      if (error.code === "ENOENT") return reject(new Error("GitHub CLI (gh) is not installed on this runner."));
      reject(new Error(stderr.trim() || error.message));
    });
  });
}

function summarize(pr) {
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
