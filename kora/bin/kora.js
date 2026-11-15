#!/usr/bin/env node
// KORA CLI entry point. Installed globally from the DoPilot web app:
//   npm i -g https://<app-domain>/kora
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = readJson(new URL("../package.json", import.meta.url));
// source.json is written by scripts/pack-kora.mjs at release time; KORA_SOURCE overrides it.
const source = process.env.KORA_SOURCE || readJson(new URL("../source.json", import.meta.url))?.url;

const commands = {
  version: () => console.log(pkg.version),
  update,
  help
};

const [command = "help"] = process.argv.slice(2);
const run = commands[command.replace(/^--?/, "")];
if (!run) {
  console.error(`Unknown command: ${command}\n`);
  help();
  process.exit(1);
}
await run();

function help() {
  console.log(`kora ${pkg.version}

Usage: kora <command>

Commands:
  version   Print the installed version
  update    Install the latest version from ${source || "<source not set>"}
  help      Show this help`);
}

async function update() {
  if (!source) {
    console.error("No update source known. Set KORA_SOURCE to the web app's /kora URL.");
    process.exit(1);
  }
  const latest = await fetch(`${source}.json`, { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  if (latest?.version === pkg.version) {
    console.log(`kora ${pkg.version} is already the latest.`);
    return;
  }
  console.log(`Updating kora ${pkg.version} -> ${latest?.version ?? "latest"}...`);
  // Reinstall into the prefix kora already lives in (e.g. C:\Users\<user>\.kora), not npm's default.
  const prefix = installPrefix();
  const prefixArg = prefix ? ` --prefix "${prefix}"` : "";
  // One command string (not an args array) so Windows can resolve npm.cmd without a shell-args warning.
  const result = spawnSync(`npm install -g --prefer-online${prefixArg} "${source}"`, { stdio: "inherit", shell: true });
  process.exit(result.status ?? 1);
}

// Global installs live at <prefix>/node_modules/<pkg> on Windows and <prefix>/lib/node_modules/<pkg> elsewhere.
function installPrefix() {
  const pkgDir = fileURLToPath(new URL("..", import.meta.url));
  const nodeModules = resolve(pkgDir, pkg.name.startsWith("@") ? "../.." : "..");
  if (basename(nodeModules) !== "node_modules") return null;
  const parent = dirname(nodeModules);
  return process.platform !== "win32" && basename(parent) === "lib" ? dirname(parent) : parent;
}

function readJson(url) {
  try {
    return JSON.parse(readFileSync(url, "utf8"));
  } catch {
    return null;
  }
}
