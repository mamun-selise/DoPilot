// `kora init`: write ~/.kora/runner.yml from existing local FE/BE clones.
import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { ensureHome, paths } from "./config.js";

const DEFAULT_BINARIES = ["git", "gh", "node", "npm", "npx", "dotnet"];

// Flags (--name, --fe, --be, --repo key=path, --yes) skip the matching prompts.
export async function init(args) {
  const flags = parseFlags(args);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question, fallback) => (await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim() || fallback || "";

  try {
    if (existsSync(paths.runner) && !flags.yes) {
      const overwrite = await ask(`${paths.runner} already exists. Overwrite? (y/N)`, "N");
      if (!/^y/i.test(overwrite)) return console.log("Left runner.yml unchanged.");
    }

    const name = flags.name || (await ask("Runner name (shown on the Runners page)", slug(userInfo().username)));
    const repos = {};
    for (const key of ["fe", "be"]) {
      const path = flags[key] ?? (await ask(`Path to your ${key.toUpperCase()} repository (blank to skip)`));
      if (path) repos[key] = repo(path);
    }
    for (const [key, path] of flags.repos) repos[key] = repo(path);
    if (!flags.yes) {
      for (;;) {
        const key = await ask("Another repository key, e.g. ops (blank to finish)");
        if (!key) break;
        repos[slug(key)] = repo(await ask(`Path to the ${key} repository`));
      }
    }
    if (!Object.keys(repos).length) throw new Error("Add at least one repository.");

    ensureHome();
    writeFileSync(paths.runner, render({ name: slug(name), repos, claude: has("claude --version"), ghAccount: ghAccount() }));
    console.log(`\nWrote ${paths.runner}`);
    console.log("Check it, then run `kora status` and `kora start`.");
  } finally {
    rl.close();
  }
}

function repo(path) {
  const full = resolve(path.replace(/^["']|["']$/g, ""));
  if (!existsSync(full)) throw new Error(`Folder not found: ${full}`);
  if (!has(`git -C "${full}" rev-parse --git-dir`)) throw new Error(`Not a git repository: ${full}`);
  const remote = run(`git -C "${full}" remote get-url origin`);
  const github = remote?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? null;
  return { path: full, github };
}

function render({ name, repos, claude, ghAccount }) {
  const width = Math.max(...Object.keys(repos).map((key) => key.length)) + 1;
  const repoLines = Object.entries(repos)
    .map(([key, r]) => `  ${(key + ":").padEnd(width)} { path: '${r.path.replace(/'/g, "''")}', github: ${r.github ?? "<owner/repo>"} }`)
    .join("\n");
  return `# KORA runner config. This file stays on this machine.
# Made by "kora init". Check the <placeholders>, then run "kora status".
name: ${name}                     # shown on the Runners page
repos:                               # your own clones; KORA works in separate worktrees, never in them
${repoLines}
agents:
  claude: { enabled: ${claude} }
github:
  account: ${ghAccount ?? "<gh account>"}             # the gh account pushes and PRs use
exec:
  allowBinaries: [${DEFAULT_BINARIES.join(", ")}]   # commands Claude may run in a task
limits: { concurrency: 1 }
dispatch:
  # Who else may send tasks to this machine. Empty: only you.
  accept: []
`;
}

function parseFlags(args) {
  const flags = { repos: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--repo") flags.repos.push(args[++i].split(/=(.*)/s).slice(0, 2));
    else if (arg.startsWith("--")) flags[arg.slice(2)] = args[++i];
  }
  return flags;
}

function ghAccount() {
  return run("gh api user --jq .login");
}

function has(command) {
  return run(command) !== null;
}

function run(command) {
  try {
    return execSync(command, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const slug = (value) => value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
