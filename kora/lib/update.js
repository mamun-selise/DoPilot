// `kora update`: reinstall the latest tarball into the folder kora already lives in.
import { spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pkg, request, source } from "./config.js";

export async function update() {
  if (!source.url) throw new Error("No update source known. Set KORA_SOURCE to the web app's /kora URL.");
  const latest = await request(`${source.url}.json`, { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  if (latest?.version === pkg.version) return console.log(`kora ${pkg.version} is already the latest.`);

  console.log(`Updating kora ${pkg.version} -> ${latest?.version ?? "latest"}...`);
  // Reinstall into the prefix kora already lives in (e.g. C:\Users\<user>\.kora), not npm's default.
  const prefix = installPrefix();
  const prefixArg = prefix ? ` --prefix "${prefix}"` : "";
  // One command string (not an args array) so Windows can resolve npm.cmd without a shell-args warning.
  const result = spawnSync(`npm install -g --prefer-online${prefixArg} "${source.url}"`, { stdio: "inherit", shell: true });
  process.exitCode = result.status ?? 1;
}

// Global installs live at <prefix>/node_modules/<pkg> on Windows and <prefix>/lib/node_modules/<pkg> elsewhere.
function installPrefix() {
  const pkgDir = fileURLToPath(new URL("..", import.meta.url));
  const nodeModules = resolve(pkgDir, pkg.name.startsWith("@") ? "../.." : "..");
  if (basename(nodeModules) !== "node_modules") return null;
  const parent = dirname(nodeModules);
  return process.platform !== "win32" && basename(parent) === "lib" ? dirname(parent) : parent;
}
