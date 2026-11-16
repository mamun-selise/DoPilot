// Release > Environments: what each environment of a deployment (yml) repo runs, and promote / rollback PRs.
// The repo keeps one file per service and environment, <service>/<dev|stg|production>/<name>.txt. Each deploy appends
// an image line, so the last line is what runs there. Dev is appended by the build pipeline; stage and prod change
// through PRs whose merge triggers that environment's deploy workflow.
import { gh, log } from "./github.js";

export const ENVIRONMENTS = ["dev", "stg", "production"];
const FILE = /^([^/]+)\/(dev|stg|production)\/[^/]+\.txt$/;
const HISTORY = 60; // newest entries returned per environment
const TITLE_ENV = { stg: "STAGE", production: "PRODUCTION" };
const BRANCH_ENV = { stg: "stg", production: "prod" };

export async function environments(repo) {
  const branch = await defaultBranch(repo);
  const files = await envFiles(repo, branch);
  const services = await Promise.all(
    Object.entries(files).map(async ([name, paths]) => {
      const envs = {};
      await Promise.all(
        Object.entries(paths).map(async ([env, path]) => {
          const [text, deployedAt] = await Promise.all([readFile(repo, path, branch), lastChange(repo, path, branch)]);
          const entries = parseEntries(text);
          envs[env] = { path, deployedAt, current: entries[0] ?? null, history: entries.slice(0, HISTORY), total: entries.length };
        })
      );
      return { name, envs };
    })
  );
  services.sort((a, b) => a.name.localeCompare(b.name));
  return { branch, services };
}

// request: { service, env: "stg" | "production", kind: "promote" | "rollback", image, merge }
export async function deployEnvironment(repo, request, from) {
  const { service, env, kind, image } = request;
  if (!TITLE_ENV[env]) throw new Error("Only stage and production are deployed through PRs.");
  if (!["promote", "rollback"].includes(kind)) throw new Error(`Unknown deployment kind "${kind}".`);

  // Re-read what is there now, so the PR matches the repository and not what the page showed earlier.
  const branch = await defaultBranch(repo);
  const files = await envFiles(repo, branch);
  const path = files[service]?.[env];
  if (!path) throw new Error(`${service} has no ${env} file in ${repo}.`);
  const file = JSON.parse(await gh(["api", `repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`], { quiet: true }));
  const text = Buffer.from(file.content, "base64").toString("utf8");
  const entries = parseEntries(text);
  const current = entries[0];

  if (kind === "promote") {
    const source = env === "stg" ? "dev" : "stg";
    const sourcePath = files[service]?.[source];
    if (!sourcePath) throw new Error(`${service} has no ${source} file to promote from.`);
    const sourceCurrent = parseEntries(await readFile(repo, sourcePath, branch))[0];
    if (!sourceCurrent || sourceCurrent.image !== image) throw new Error(`${source} of ${service} has moved on since the page loaded; refresh and try again.`);
  } else if (!entries.some((entry) => entry.image === image)) {
    throw new Error(`${image} is not in the ${env} history of ${service}.`);
  }
  if (current?.image === image) throw new Error(`${env} of ${service} already runs ${describe(parseImage(image))}.`);

  const target = parseImage(image);
  const label = target.version ?? target.build ?? target.sha?.slice(0, 7) ?? "image";
  const name = service.charAt(0).toUpperCase() + service.slice(1);
  const title = kind === "promote" ? `${name} - Deploy to ${TITLE_ENV[env]} - ${label}` : `${name} - Rollback ${TITLE_ENV[env]} to ${label}`;
  const prBranch = await freeBranch(repo, `${service}-${BRANCH_ENV[env]}-${kind === "rollback" ? "rollback-" : ""}${target.build ?? Date.now()}`);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const content = `${text}${text === "" || text.endsWith("\n") ? "" : newline}${image}${newline}`;

  log(`Environments: ${kind} ${service} ${env} -> ${label} (${prBranch})`);
  const head = JSON.parse(await gh(["api", `repos/${repo}/git/ref/heads/${branch}`])).object.sha;
  await gh(["api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${prBranch}`, "-f", `sha=${head}`]);
  // The file goes in on stdin: base64 of a long history is past Windows' command-line limit.
  await gh(["api", "-X", "PUT", `repos/${repo}/contents/${path}`, "--input", "-"], {
    input: JSON.stringify({ message: title, content: Buffer.from(content, "utf8").toString("base64"), sha: file.sha, branch: prBranch })
  });
  const body = [
    `${kind === "promote" ? "Promotes" : "Rolls back"} **${service}** on **${TITLE_ENV[env]}**`,
    "",
    `- from: \`${current?.image ?? "nothing"}\``,
    `- to: \`${image}\``,
    "",
    `Opened from DoPilot (Release > Environments) for ${from?.email || from?.sub || "unknown"}. Merging deploys it.`
  ].join("\n");
  const url = (await gh(["pr", "create", "--repo", repo, "--base", branch, "--head", prBranch, "--title", title, "--body", body])).trim();
  const number = Number(url.split("/").pop());
  let merged = false;
  if (request.merge) {
    await gh(["pr", "merge", String(number), "--repo", repo, "--merge"]);
    merged = true;
  }
  log(`  ✓ ${merged ? "merged" : "opened"} ${url}`);
  return { url, number, title, merged };
}

async function defaultBranch(repo) {
  return JSON.parse(await gh(["api", `repos/${repo}`], { quiet: true })).default_branch;
}

// { service: { dev: path, stg: path, production: path } }; the first .txt wins when a folder holds several.
async function envFiles(repo, branch) {
  const tree = JSON.parse(await gh(["api", `repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`]));
  const files = {};
  for (const item of tree.tree ?? []) {
    const match = item.type === "blob" && item.path.match(FILE);
    if (!match) continue;
    const [, service, env] = match;
    files[service] ??= {};
    files[service][env] ??= item.path;
  }
  return files;
}

async function readFile(repo, path, branch) {
  return gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`], { quiet: true });
}

async function lastChange(repo, path, branch) {
  const commits = JSON.parse(await gh(["api", `repos/${repo}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(branch)}&per_page=1`], { quiet: true }));
  return commits[0]?.commit?.committer?.date ?? null;
}

// Newest first. A line is registry/name:tag; tags look like <sha>-<build>-v<version>, though older ones vary.
function parseEntries(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .map(parseImage);
}

export function parseImage(image) {
  const tag = image.slice(image.lastIndexOf(":") + 1);
  const match = tag.match(/^([0-9a-f]{7,40})(?:-(\d+))?(?:-(.+))?$/i);
  const rest = match?.[3] ?? null;
  return {
    image,
    tag,
    sha: match?.[1] ?? null,
    build: match?.[2] ? Number(match[2]) : null,
    version: rest && /^v\d/.test(rest) ? rest : null,
    suffix: rest && !/^v\d/.test(rest) ? rest : null
  };
}

function describe(entry) {
  return entry.version ?? (entry.build ? `build ${entry.build}` : entry.tag);
}

async function freeBranch(repo, base) {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    try {
      await gh(["api", `repos/${repo}/git/ref/heads/${name}`], { quiet: true });
    } catch {
      return name; // 404: not taken
    }
  }
}
