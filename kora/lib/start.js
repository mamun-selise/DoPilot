// `kora start`: keep an outbound SignalR connection to the KORA backend and run the tasks it sends.
import { execFileSync, execSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { arch, hostname, release } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import * as signalR from "@microsoft/signalr";
import { accessToken, session } from "./auth.js";
import { isDeployment, loadRunner, paths, pkg, source } from "./config.js";
import { addLocalRepository, addRepository, github, localCandidates, log, removeRepository, setDeployment, who } from "./github.js";
import { cancelMergeQueue, startMergeQueue } from "./release.js";

export async function start() {
  const runner = loadRunner();
  if (!runner) throw new Error("No runner.yml yet. Run `kora init` first.");
  if (!source.hubUrl) throw new Error("This kora build has no backend URL. Set KORA_HUB_URL or reinstall from the web app.");
  await accessToken(); // fail fast when not logged in
  const me = session().user;

  const connection = new signalR.HubConnectionBuilder()
    .withUrl(source.hubUrl, { accessTokenFactory: () => accessToken() })
    .withAutomaticReconnect({ nextRetryDelayInMilliseconds: (ctx) => Math.min(30_000, 1000 * 2 ** ctx.previousRetryCount) })
    .configureLogging(signalR.LogLevel.Warning)
    .build();

  const running = new Map(); // taskId -> child process
  const queue = [];
  const concurrency = Math.max(1, Number(runner.limits?.concurrency) || 1);

  connection.on("RunTask", (task) => {
    const refusal = refuse(task, runner, me);
    if (refusal) return void connection.invoke("TaskCompleted", task.id, { ok: false, error: refusal }).catch(() => {});
    queue.push(task);
    pump();
  });
  connection.on("CancelTask", (taskId) => {
    running.get(taskId)?.kill();
    const queued = queue.findIndex((task) => task.id === taskId);
    if (queued >= 0) {
      queue.splice(queued, 1);
      connection.invoke("TaskCompleted", taskId, { ok: false, error: "Cancelled before it started." }).catch(() => {});
    }
  });

  // The PRs and Repo settings pages, done with this machine's gh login. The return value is the answer.
  connection.on("GitHub", (request) => {
    if (accepts(request?.from, runner, me)) return github(request, runner);
    log(`GitHub ${request?.action} ${request?.repo} — refused: ${who(request?.from)} is not in dispatch.accept`);
    return { ok: false, error: notAccepted(request?.from) };
  });

  // Release > Ready to stage: merge the queued PRs one at a time, each after the previous one's build finished.
  // Answers at once; progress goes back with MergeQueueProgress.
  connection.on("MergeQueue", (request) => {
    if (!accepts(request?.from, runner, me)) return { ok: false, error: notAccepted(request?.from) };
    const known = Object.values(runner.repos ?? {}).some((repo) => repo.github?.toLowerCase() === String(request?.repo).toLowerCase());
    if (!known) return { ok: false, error: `${request?.repo} is not a repository in this runner's runner.yml.` };
    return startMergeQueue(request, (update) => connection.invoke("MergeQueueProgress", request.queueId, update).catch(() => {}));
  });
  connection.on("CancelMergeQueue", (queueId) => cancelMergeQueue(queueId));

  // Add/remove a GitHub-only repository from the web app. Only the owner may change what this machine offers.
  connection.on("ManageRepository", async (request) => {
    if (!request?.from?.sub || request.from.sub !== me.sub) {
      log(`Repo ${request?.action} ${request?.repo} — refused: ${who(request?.from)} is not this runner's owner`);
      return { ok: false, error: "Only the runner's owner can add or remove its repositories." };
    }
    if (request.action === "candidates") return localCandidates(runner);
    const answer =
      request.action === "remove" ? await removeRepository(request, runner)
      : request.action === "setDeployment" ? setDeployment(request, runner)
      : request.action === "addLocal" ? await addLocalRepository(request, runner)
      : await addRepository(request, runner);
    // Re-register once this answer is on its way, so the web app's repository list picks up the change.
    if (answer.ok) setTimeout(() => register().catch(() => {}), 0);
    return answer;
  });

  const claudeVersion = run("claude --version")?.split(" ")[0] ?? null;
  // Re-read on every (re)connect so the Runners page shows each clone's current branch.
  const register = () =>
    connection.invoke("RegisterRunner", {
      name: runner.name,
      machine: hostname(),
      version: pkg.version,
      repos: Object.entries(runner.repos ?? {}).map(([key, repo]) => ({
        key,
        github: repo.github ?? null,
        branch: repo.path ? run(`git -C "${repo.path}" rev-parse --abbrev-ref HEAD`) : null,
        local: Boolean(repo.path),
        deployment: isDeployment(key, repo)
      })),
      agents: Object.keys(runner.agents ?? {}).filter((key) => runner.agents[key]?.enabled),
      concurrency,
      platform: `${{ win32: "Windows", darwin: "macOS", linux: "Linux" }[process.platform] ?? process.platform} ${release()} (${arch()})`,
      nodeVersion: process.version,
      claudeVersion,
      githubAccount: runner.github?.account ?? null,
      allowBinaries: runner.exec?.allowBinaries ?? [],
      dispatchAccept: (runner.dispatch?.accept ?? []).flatMap((rule) => rule.from ?? [])
    });
  connection.onreconnecting(() => console.log("Connection lost, reconnecting..."));
  connection.onreconnected(async () => {
    await register();
    console.log("Reconnected.");
  });

  await connection.start();
  await register();
  console.log(`KORA runner "${runner.name}" is online as ${me.email || me.sub}. Waiting for tasks (Ctrl+C to stop).`);

  process.on("SIGINT", async () => {
    for (const child of running.values()) child.kill();
    await connection.stop();
    process.exit(0);
  });
  await new Promise(() => {}); // run until stopped

  function pump() {
    while (running.size < concurrency && queue.length) {
      const task = queue.shift();
      runTask(task, runner, connection, running)
        .catch((error) => connection.invoke("TaskCompleted", task.id, { ok: false, error: error.message }).catch(() => {}))
        .finally(() => {
          running.delete(task.id);
          pump();
        });
    }
  }
}

function refuse(task, runner, me) {
  if (!runner.repos?.[task.repo]) return `Repository "${task.repo}" is not in this runner's runner.yml.`;
  if (!runner.repos[task.repo].path) return `Repository "${task.repo}" has no local clone on this runner (GitHub only), so tasks cannot run on it.`;
  return accepts(task.from, runner, me) ? null : notAccepted(task.from);
}

// Only the runner's owner may use it unless runner.yml's dispatch.accept lists the sender.
function accepts(from, runner, me) {
  from ??= {};
  if (from.sub && from.sub === me.sub) return true;
  return (runner.dispatch?.accept ?? []).some((rule) => (rule.from ?? []).some((who) => who === from.email || who === from.sub));
}

function notAccepted(from) {
  return `This runner only accepts requests from its owner (dispatch.accept does not list ${from?.email || "the sender"}).`;
}

async function runTask(task, runner, connection, running) {
  const repo = runner.repos[task.repo];
  const branch = `kora/${task.id.slice(0, 8)}`;
  const dir = join(paths.worktrees, runner.name, task.id);
  mkdirSync(join(paths.worktrees, runner.name), { recursive: true });
  execFileSync("git", ["-C", repo.path, "worktree", "add", "-b", branch, dir, task.base || "HEAD"], { stdio: "ignore" });

  console.log(`Task ${task.id} on ${task.repo} (${branch}) started.`);
  await connection.invoke("TaskStarted", task.id, { branch, worktree: dir });

  // The prompt goes in on stdin, so the shell command line holds no task content.
  const tools = (runner.exec?.allowBinaries ?? []).map((bin) => `"Bash(${bin}:*)"`).join(" ");
  const command = `claude -p --output-format stream-json --verbose --permission-mode acceptEdits${tools ? ` --allowedTools ${tools}` : ""}`;
  const child = spawn(command, { cwd: dir, shell: true, stdio: ["pipe", "pipe", "pipe"] });
  running.set(task.id, child);
  child.stdin.end(task.prompt);

  let result = null;
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const event = summarize(line);
    if (!event) return;
    if (event.kind === "result") result = event;
    connection.send("TaskLog", task.id, event).catch(() => {});
  });

  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  const ok = exitCode === 0 && result && !result.isError;
  console.log(`Task ${task.id} ${ok ? "finished" : "failed"} (exit ${exitCode}).`);
  await connection.invoke("TaskCompleted", task.id, {
    ok: Boolean(ok),
    exitCode,
    result: result?.text ?? null,
    costUsd: result?.costUsd ?? null,
    branch,
    worktree: dir,
    error: ok ? null : stderr.trim() || result?.text || `claude exited with ${exitCode}`
  });
}

// Reduce Claude Code's stream-json events to what the web app shows.
function summarize(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (event.type === "system" && event.subtype === "init") return { kind: "init", model: event.model };
  if (event.type === "result")
    return { kind: "result", text: event.result ?? null, isError: Boolean(event.is_error), costUsd: event.total_cost_usd ?? null, durationMs: event.duration_ms ?? null };
  if (event.type !== "assistant") return null;
  const parts = event.message?.content ?? [];
  const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const tools = parts.filter((part) => part.type === "tool_use").map((part) => ({ name: part.name, input: shorten(part.input) }));
  if (!text && !tools.length) return null;
  return { kind: "assistant", text: text || null, tools };
}

function run(command) {
  try {
    return execSync(command, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function shorten(input) {
  const text = JSON.stringify(input ?? {});
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}
