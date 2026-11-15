// `kora status`: login, runner.yml, agents and backend reachability at a glance.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { accessToken, session } from "./auth.js";
import { loadRunner, paths, pkg, request, source } from "./config.js";

export async function status() {
  const ok = (good, text) => console.log(`  ${good ? "✓" : "✗"} ${text}`);
  console.log(`kora ${pkg.version}  (${paths.runner.replace(/runner\.yml$/, "")})\n`);

  console.log("Login");
  const current = session();
  if (!current) ok(false, "not logged in — run `kora login`");
  else {
    const refreshed = await accessToken().then(() => true, () => false);
    ok(refreshed, `${current.user.email || current.user.name || current.user.sub}${refreshed ? "" : " — session expired, run `kora login`"}`);
  }

  console.log("\nRunner (runner.yml)");
  let runner = null;
  try {
    runner = loadRunner();
  } catch (error) {
    ok(false, `runner.yml does not parse: ${error.message}`);
  }
  if (!runner && existsSync(paths.runner) === false) ok(false, "no runner.yml — run `kora init`");
  if (runner) {
    ok(Boolean(runner.name), `name: ${runner.name ?? "<missing>"}`);
    for (const [key, repo] of Object.entries(runner.repos ?? {})) {
      const isRepo = repo?.path && existsSync(repo.path) && run(`git -C "${repo.path}" rev-parse --git-dir`) !== null;
      ok(isRepo, `${key}: ${repo?.path ?? "<no path>"}${repo?.github ? ` (${repo.github})` : ""}${isRepo ? "" : " — not a git repository"}`);
    }
  }

  console.log("\nAgents");
  const claude = run("claude --version");
  ok(Boolean(claude), claude ? `Claude Code ${claude.split(" ")[0]}` : "Claude Code not found on PATH");

  console.log("\nBackend");
  if (!source.hubUrl) ok(false, "no backend URL in this build");
  else {
    const health = source.hubUrl.replace(/\/hubs\/.*$/, "/healthz");
    const reachable = await request(health, { signal: AbortSignal.timeout(5000) }, 2).then((res) => res.ok, () => false);
    ok(reachable, `${source.hubUrl}${reachable ? "" : " — not reachable"}`);
  }
}

function run(command) {
  try {
    return execSync(command, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}
