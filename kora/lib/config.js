// Where KORA keeps its files, and what the web app told it at pack time.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

export const pkg = readJson(new URL("../package.json", import.meta.url));

// source.json is written by scripts/pack-kora.mjs at release time. KORA_* env vars override it (local testing).
const packed = readJson(new URL("../source.json", import.meta.url)) ?? {};
export const source = {
  url: process.env.KORA_SOURCE || packed.url,
  iamUrl: process.env.KORA_IAM_URL || packed.iamUrl,
  tenantId: process.env.KORA_TENANT_ID || packed.tenantId,
  clientId: process.env.KORA_CLIENT_ID || packed.clientId,
  hubUrl: process.env.KORA_HUB_URL || packed.hubUrl
};

export const home = process.env.KORA_HOME || join(homedir(), ".kora");
export const paths = {
  credentials: join(home, "credentials.json"),
  runner: join(home, "runner.yml"),
  worktrees: join(home, "worktrees")
};

export function ensureHome() {
  mkdirSync(home, { recursive: true });
}

// The deployment (yml) repo shows only on the web app's Deploy to stage / prod pages. runner.yml's `yml` repo is one
// unless it says `deployment: false`; any other repo is one when it says `deployment: true`.
export function isDeployment(key, repo) {
  return repo?.deployment ?? key === "yml";
}

export function loadRunner() {
  if (!existsSync(paths.runner)) return null;
  return YAML.parse(readFileSync(paths.runner, "utf8"));
}

// fetch that retries brief network failures ("fetch failed"); HTTP error responses are returned as-is.
export async function request(url, options, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, options);
    } catch (error) {
      if (attempt >= attempts || error.name === "TimeoutError") {
        throw new Error(`Could not reach ${new URL(url).host} (${error.cause?.code || error.cause?.message || error.message}).`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writePrivateJson(file, value) {
  ensureHome();
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
