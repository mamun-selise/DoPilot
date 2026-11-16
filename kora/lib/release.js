// The web app's Release > Ready to stage board. Board state lives on GitHub as labels, so everyone sees the same
// board and it survives restarts: READY marks column 2, DEPLOYED marks a merged PR whose build succeeded.
import { gh, log, PR_FIELDS, summarize, who } from "./github.js";

export const READY = "ready-for-stage";
export const DEPLOYED = "deployed-to-stage";
const LABELS = {
  [READY]: { color: "0E8A16", description: "Queued for the next stage deployment (DoPilot)" },
  [DEPLOYED]: { color: "1D76DB", description: "Merged and its build finished (DoPilot)" }
};
const MERGED_FIELDS = "number,title,url,author,headRefName,baseRefName,mergedAt,labels,mergeCommit";
const POLL_MS = 15_000;
const RUNS_APPEAR_MS = 3 * 60_000; // how long a merge commit may take to start its workflow runs
const BUILD_TIMEOUT_MS = 90 * 60_000;

// Open PRs (columns 1 and 2, split by READY) and merged PRs that went through the board (columns 3 and 4).
export async function board(repo) {
  const open = JSON.parse(await gh(["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", PR_FIELDS])).map(summarize);
  let merged = [];
  try {
    merged = JSON.parse(await gh(["pr", "list", "--repo", repo, "--state", "merged", "--label", READY, "--limit", "40", "--json", MERGED_FIELDS])).map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author?.login ?? null,
      head: pr.headRefName,
      base: pr.baseRefName,
      mergedAt: pr.mergedAt,
      labels: (pr.labels ?? []).map((label) => label.name),
      mergeCommit: pr.mergeCommit?.oid ?? null
    }));
  } catch {
    // A repo that has never used the board has no READY label yet; nothing has been merged through it.
  }
  return { open, merged };
}

export async function setStage(repo, number, ready) {
  if (ready) await ensureLabel(repo, READY);
  await gh(["pr", "edit", String(number), "--repo", repo, ready ? "--add-label" : "--remove-label", READY]);
}

async function ensureLabel(repo, name) {
  await gh(["label", "create", name, "--repo", repo, "--color", LABELS[name].color, "--description", LABELS[name].description, "--force"]);
}

// ---- the merge queue: one PR at a time, each waiting for the build on its merge commit ----

const queues = new Map(); // queueId -> { cancelled }

// Starts in the background and returns at once; progress goes to the backend through report(update).
export function startMergeQueue(request, report) {
  const { queueId, repo, numbers, method, deleteBranch } = request;
  if (!Array.isArray(numbers) || !numbers.length || !numbers.every((n) => Number.isInteger(n) && n > 0)) return { ok: false, error: "No pull requests to merge." };
  if (!["merge", "squash", "rebase"].includes(method)) return { ok: false, error: "Merge method must be merge, squash or rebase." };
  const state = { cancelled: false };
  queues.set(queueId, state);
  log(`Release queue for ${repo}: ${numbers.map((n) => `#${n}`).join(", ")} (${method}) — requested by ${who(request.from)}`);
  run().finally(() => queues.delete(queueId));
  return { ok: true };

  async function run() {
    for (const [index, number] of numbers.entries()) {
      if (state.cancelled) {
        for (const rest of numbers.slice(index)) await report({ number: rest, state: "skipped", message: "Queue cancelled." });
        log(`Release queue for ${repo} cancelled.`);
        return report({ done: true, status: "cancelled" });
      }
      try {
        await mergeOne(repo, number, method, deleteBranch, report);
      } catch (error) {
        log(`  ✗ #${number}: ${error.message}`);
        await report({ number, state: "failed", message: error.message });
        for (const rest of numbers.slice(index + 1)) await report({ number: rest, state: "skipped", message: `Not merged: #${number} failed.` });
        return report({ done: true, status: "failed" });
      }
    }
    log(`Release queue for ${repo} finished.`);
    return report({ done: true, status: "succeeded" });
  }
}

export function cancelMergeQueue(queueId) {
  const state = queues.get(queueId);
  if (state) {
    state.cancelled = true;
    log("Release queue: cancel requested; stopping after the current pull request.");
  }
  return { ok: Boolean(state) };
}

async function mergeOne(repo, number, method, deleteBranch, report) {
  await report({ number, state: "merging" });
  log(`Release: merging ${repo}#${number}`);
  const pr = JSON.parse(await gh(["pr", "view", String(number), "--repo", repo, "--json", "state,isDraft,mergeStateStatus"]));
  if (pr.state !== "OPEN") throw new Error(`#${number} is ${pr.state.toLowerCase()}, not open.`);
  if (pr.isDraft) throw new Error(`#${number} is a draft.`);

  const merge = ["pr", "merge", String(number), "--repo", repo, `--${method}`, ...(deleteBranch ? ["--delete-branch"] : [])];
  try {
    await gh(merge);
  } catch (error) {
    // After the previous merge this branch may be behind its base; when protection requires it to be up to date,
    // update it, wait for its checks, and try once more.
    const status = JSON.parse(await gh(["pr", "view", String(number), "--repo", repo, "--json", "mergeStateStatus"])).mergeStateStatus;
    if (status !== "BEHIND") throw error;
    await report({ number, state: "updating", message: "Branch was behind its base; updating it and waiting for its checks." });
    log(`Release: #${number} is behind its base; updating the branch`);
    await gh(["pr", "update-branch", String(number), "--repo", repo]);
    await sleep(10_000); // let the new checks register before watching them
    await gh(["pr", "checks", String(number), "--repo", repo, "--watch", "--fail-fast", "--interval", "15"], { timeout: BUILD_TIMEOUT_MS }).catch((failure) => {
      if (/no checks reported/i.test(failure.message)) return; // nothing to wait for
      throw new Error(`Checks failed after updating the branch: ${failure.message}`);
    });
    await gh(merge);
  }

  const sha = await mergeCommit(repo, number);
  await report({ number, state: "building", commit: sha, message: "Merged. Waiting for the build on the merge commit." });
  log(`Release: #${number} merged as ${sha.slice(0, 7)}; waiting for its workflow runs`);

  const runs = await waitForRuns(repo, sha, number, report);
  if (!runs.length) {
    await report({ number, state: "merged", commit: sha, message: "No workflow run started for the merge commit, so there is no build to wait for." });
    log(`Release: #${number} — no workflow run started for ${sha.slice(0, 7)}; moving on`);
    return;
  }
  const failed = runs.filter((r) => !["success", "skipped", "neutral"].includes(r.conclusion));
  if (failed.length) {
    await report({ number, state: "failed", commit: sha, runUrl: failed[0].url, runs: brief(runs) });
    throw new Error(`Build failed: ${failed.map((r) => `${r.workflowName || r.name} (${r.conclusion})`).join(", ")}.`);
  }
  await ensureLabel(repo, DEPLOYED);
  await gh(["pr", "edit", String(number), "--repo", repo, "--add-label", DEPLOYED]);
  await report({ number, state: "deployed", commit: sha, runUrl: runs[0].url, runs: brief(runs) });
  log(`  ✓ #${number} built: ${runs.map((r) => r.workflowName || r.name).join(", ")}`);
}

async function mergeCommit(repo, number) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const pr = JSON.parse(await gh(["pr", "view", String(number), "--repo", repo, "--json", "state,mergeCommit"], { quiet: attempt > 0 }));
    if (pr.state === "MERGED" && pr.mergeCommit?.oid) return pr.mergeCommit.oid;
    await sleep(3_000);
  }
  throw new Error(`GitHub did not report #${number} as merged.`);
}

// Waits for the runs on the merge commit to appear, then until every one of them has completed.
async function waitForRuns(repo, sha, number, report) {
  const started = Date.now();
  let lastSummary = "";
  for (;;) {
    const runs = JSON.parse(await gh(["run", "list", "--repo", repo, "--commit", sha, "--json", "databaseId,name,workflowName,status,conclusion,url,event"], { quiet: true }));
    const waited = Date.now() - started;
    if (!runs.length && waited > RUNS_APPEAR_MS) return [];
    if (runs.length && runs.every((r) => r.status === "completed")) return runs;
    if (waited > BUILD_TIMEOUT_MS) throw new Error(`The build on ${sha.slice(0, 7)} did not finish within ${BUILD_TIMEOUT_MS / 60_000} minutes.`);

    const summary = runs.map((r) => `${r.workflowName || r.name}: ${r.status}`).join(", ");
    if (summary && summary !== lastSummary) {
      lastSummary = summary;
      log(`  … #${number} ${summary}`);
      await report({ number, state: "building", commit: sha, runUrl: runs[0].url, runs: brief(runs) });
    }
    await sleep(POLL_MS);
  }
}

function brief(runs) {
  return runs.map((r) => ({ name: r.workflowName || r.name, status: r.status, conclusion: r.conclusion || null, url: r.url }));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
