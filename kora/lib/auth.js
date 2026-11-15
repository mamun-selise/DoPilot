// Blocks IAM login via the OAuth device-code flow, plus token refresh.
import { exec } from "node:child_process";
import { rmSync } from "node:fs";
import { paths, readJson, request, source, writePrivateJson } from "./config.js";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export async function login() {
  requireSource();
  const oidc = await discovery();
  const device = await postForm(oidc.device_authorization_endpoint, {
    client_id: source.clientId,
    scope: "openid profile offline_access"
  });
  if (!device.device_code) throw new Error(`Device login failed: ${describe(device)}`);

  const verifyUrl = device.verification_uri_complete || device.verification_uri;
  console.log(`\nApprove this device in your browser:\n  URL:  ${verifyUrl}\n  Code: ${device.user_code}\n`);
  openBrowser(verifyUrl);
  console.log("Waiting for approval...");

  let interval = (device.interval || 5) * 1000;
  const deadline = Date.now() + (device.expires_in || 600) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const token = await postForm(oidc.token_endpoint, {
      grant_type: DEVICE_GRANT,
      device_code: device.device_code,
      client_id: source.clientId
    });
    if (token.access_token) {
      const session = save(token);
      console.log(`Logged in as ${session.user.email || session.user.name || session.user.sub}.`);
      return session;
    }
    if (token.error === "slow_down") interval += 5000;
    else if (token.error !== "authorization_pending") throw new Error(`Device login failed: ${describe(token)}`);
  }
  throw new Error("Device login expired before it was approved. Run `kora login` again.");
}

export function logout() {
  rmSync(paths.credentials, { force: true });
}

export function session() {
  const current = readJson(paths.credentials);
  // Sessions saved before ids were canonicalized may still hold "blocks|<id>".
  if (current?.user?.sub) current.user.sub = canonicalId(current.user.sub);
  return current;
}

// A valid access token, refreshed when it is about to expire. Throws when there is no usable session.
export async function accessToken() {
  const current = session();
  if (!current) throw new Error("Not logged in. Run `kora login`.");
  if (current.expiresAt - Date.now() > 60_000) return current.accessToken;
  if (!current.refreshToken) throw new Error("Session expired. Run `kora login`.");

  const oidc = await discovery();
  const token = await postForm(oidc.token_endpoint, {
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
    client_id: source.clientId
  });
  if (!token.access_token) throw new Error(`Session refresh failed (${describe(token)}). Run \`kora login\`.`);
  return save(token, current.refreshToken).accessToken;
}

function save(token, previousRefreshToken) {
  const claims = decodeJwt(token.id_token) ?? decodeJwt(token.access_token) ?? {};
  const access = decodeJwt(token.access_token) ?? {};
  const previous = session()?.user ?? {};
  const value = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || previousRefreshToken || null,
    expiresAt: Date.now() + (token.expires_in || 300) * 1000,
    tenantId: source.tenantId,
    user: {
      sub: canonicalId(access.sub ?? claims.sub, access.user_id ?? claims.user_id),
      // A refreshed token may come without an id_token; keep what login learned.
      email: claims.email ?? previous.email,
      name: claims.name || claims.preferred_username || previous.name
    }
  };
  writePrivateJson(paths.credentials, value);
  return value;
}

let cachedDiscovery;
async function discovery() {
  cachedDiscovery ??= await request(`${source.iamUrl}/${source.tenantId}/.well-known/openid-configuration`).then((res) => {
    if (!res.ok) throw new Error(`Could not read the login configuration (HTTP ${res.status}).`);
    return res.json();
  });
  return cachedDiscovery;
}

async function postForm(url, body) {
  const res = await request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body)
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: `http_${res.status}`, error_description: text.slice(0, 200) };
  }
}

// One id per person, matching the backend: IAM's `sub` is the bare user id on a device-code token but
// "blocks|<id>" on a refreshed one, so prefer `user_id` and otherwise strip the "provider|" prefix.
function canonicalId(sub, userId) {
  return userId || (sub ? sub.slice(sub.lastIndexOf("|") + 1) : sub);
}

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function describe(response) {
  return response.error_description || response.error || JSON.stringify(response).slice(0, 200);
}

function requireSource() {
  const missing = ["iamUrl", "tenantId", "clientId"].filter((key) => !source[key]);
  if (missing.length) throw new Error(`This kora build has no login settings (${missing.join(", ")}). Reinstall it from the web app.`);
}

function openBrowser(url) {
  const command =
    process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(command, () => {});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
