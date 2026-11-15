#!/usr/bin/env node
// Packs the KORA CLI into dist so the web app serves it as an npm-installable tarball:
//   dist/kora.tgz             latest (served at /kora and /kora.tgz)
//   dist/kora-<version>.tgz   pinned version
//   dist/kora.json            { name, version, tarball } for `kora update`
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dotEnv = readDotEnv(".env");
const env = (key) => (process.env[key] || dotEnv[key] || "").replace(/\/+$/, "");
const appDomain = env("VITE_BLOCKS_APP_DOMAIN");
if (!appDomain) {
  console.error("pack-kora: VITE_BLOCKS_APP_DOMAIN is not set; cannot record the update source.");
  process.exit(1);
}

const stage = mkdtempSync(join(tmpdir(), "kora-"));
try {
  cpSync("kora", stage, { recursive: true, filter: (src) => !/[\\/]node_modules([\\/]|$)/.test(src) });
  // Everything the CLI needs to log in and connect; all public values.
  const settings = {
    url: `${appDomain}/kora`,
    iamUrl: env("VITE_BLOCKS_OIDC_URL"),
    tenantId: env("VITE_BLOCKS_X_BLOCKS_KEY"),
    clientId: env("KORA_CLI_CLIENT_ID"),
    hubUrl: env("VITE_KORA_HUB_URL")
  };
  for (const [key, value] of Object.entries(settings)) if (!value) console.warn(`pack-kora: ${key} is empty; kora will need it from the environment.`);
  writeFileSync(join(stage, "source.json"), JSON.stringify(settings, null, 2) + "\n");

  mkdirSync("dist", { recursive: true });
  const packed = JSON.parse(
    execSync(`npm pack "${stage}" --pack-destination dist --json`, { encoding: "utf8" })
  )[0];

  const versioned = join("dist", `kora-${packed.version}.tgz`);
  renameSync(join("dist", packed.filename), versioned);
  copyFileSync(versioned, join("dist", "kora.tgz"));
  writeFileSync(
    join("dist", "kora.json"),
    JSON.stringify({ name: packed.name, version: packed.version, tarball: `${appDomain}/kora-${packed.version}.tgz` }, null, 2) + "\n"
  );
  console.log(`Packed ${packed.name}@${packed.version} -> dist/kora.tgz, ${versioned}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

function readDotEnv(file) {
  if (!existsSync(file)) return {};
  const values = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}
