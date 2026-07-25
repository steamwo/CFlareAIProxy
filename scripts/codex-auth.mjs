#!/usr/bin/env node
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

const command = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "login";
const argv = command === "login" && process.argv[2]?.startsWith("--") ? process.argv.slice(2) : process.argv.slice(3);

function arg(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
}
function has(name) { return argv.includes(`--${name}`); }
function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const output = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    output[line.slice(0, index).trim()] = value;
  }
  return output;
}
const localEnv = parseEnvFile(resolve(process.cwd(), ".dev.vars"));
const gateway = String(arg("gateway", process.env.CFLARE_GATEWAY_URL || localEnv.CFLARE_GATEWAY_URL || "http://127.0.0.1:8787")).replace(/\/$/, "");
const adminToken = arg("admin-token", process.env.ADMIN_TOKEN || localEnv.ADMIN_TOKEN);
const providerId = arg("provider", "codex");
const proxy = arg("proxy", process.env.ALL_PROXY || process.env.all_proxy || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "");
const supportedProxySchemes = new Set(["http:", "https:", "socks:", "socks4:", "socks4a:", "socks5:", "socks5h:"]);
const authDir = resolve(arg("auth-dir", join(process.cwd(), ".cflare", "auth")));

function fail(message) { console.error(`✗ ${message}`); process.exit(1); }
if (!adminToken) fail("缺少 ADMIN_TOKEN。请放入 .dev.vars、环境变量，或使用 --admin-token。");
if (proxy) {
  let parsedProxy;
  try { parsedProxy = new URL(proxy); } catch { fail("代理 URL 格式无效。示例：http://127.0.0.1:7890 或 socks5h://127.0.0.1:1080"); }
  if (!supportedProxySchemes.has(parsedProxy.protocol) || !parsedProxy.hostname || !parsedProxy.port) {
    fail("代理仅支持 HTTP、HTTPS、SOCKS、SOCKS4/4a、SOCKS5/5h，并且必须包含主机和端口。");
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${gateway}/admin/api${path}`, {
    ...options,
    headers: { "content-type": "application/json", "x-admin-token": adminToken, ...(options.headers || {}) },
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { message: text }; }
  if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `CFlareAIProxy returned HTTP ${response.status}`);
  return payload;
}
function base64url(bytes) { return Buffer.from(bytes).toString("base64url"); }
function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8")); } catch { return {}; }
}
function openBrowser(url) {
  if (has("no-browser")) return;
  const commandName = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(commandName, args, () => {});
}
function curlCommand() { return process.platform === "win32" ? "curl.exe" : "curl"; }
function exchangeWithCurl(url, form) {
  const args = ["--silent", "--show-error", "--location", "--request", "POST", "--header", "Accept: application/json", "--header", "Content-Type: application/x-www-form-urlencoded", "--data-binary", "@-"];
  if (proxy) args.unshift("--proxy", proxy);
  args.push(url);
  const result = spawnSync(curlCommand(), args, { input: form.toString(), encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || `curl exit ${result.status}`).trim());
  let payload;
  try { payload = JSON.parse(String(result.stdout || "{}")); } catch { throw new Error(`Token endpoint returned non-JSON: ${String(result.stdout || "").slice(0, 500)}`); }
  if (!payload.access_token) throw new Error(payload.error_description || payload.error || "Token endpoint returned no access_token");
  return payload;
}
async function exchangeToken(url, form) {
  if (proxy || has("curl")) return exchangeWithCurl(url, form);
  const response = await fetch(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: form });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok || !payload.access_token) {
    const detail = payload.error_description || payload.error || payload.raw || `HTTP ${response.status}`;
    throw new Error(`OAuth token endpoint returned ${response.status}: ${detail}`);
  }
  return payload;
}
function normalizedAuth(input) {
  const root = input && typeof input === "object" ? input : {};
  const tokens = root.tokens && typeof root.tokens === "object" ? root.tokens : root;
  const accessToken = tokens.access_token || tokens.accessToken || tokens.token;
  const refreshToken = tokens.refresh_token || tokens.refreshToken;
  const idToken = tokens.id_token || tokens.idToken;
  if (!accessToken) throw new Error("授权文件没有 access_token");
  const accessClaims = decodeJwt(accessToken);
  const idClaims = decodeJwt(idToken);
  const authClaim = accessClaims["https://api.openai.com/auth"] || idClaims["https://api.openai.com/auth"] || {};
  const accountId = tokens.account_id || authClaim.chatgpt_account_id || accessClaims.chatgpt_account_id || idClaims.chatgpt_account_id;
  const email = accessClaims.email || idClaims.email;
  const expiresAt = Number(accessClaims.exp || idClaims.exp || 0) || undefined;
  return { accessToken, refreshToken, idToken, accountId, email, expiresAt, tokenType: root.token_type || "Bearer", scope: root.scope };
}
function safeName(value) { return String(value || "account").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80); }
function saveAuth(auth, credentialId, target) {
  mkdirSync(dirname(target), { recursive: true });
  const payload = {
    format: "cflare-codex-auth-v1",
    provider_id: providerId,
    credential_id: credentialId,
    gateway,
    saved_at: new Date().toISOString(),
    tokens: {
      access_token: auth.accessToken,
      refresh_token: auth.refreshToken,
      id_token: auth.idToken,
      account_id: auth.accountId,
    },
  };
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(target, 0o600); } catch {}
  return target;
}
async function uploadAuth(auth, label, credentialId) {
  const metadata = {
    id_token: auth.idToken,
    account_id: auth.accountId,
    email: auth.email,
    token_type: auth.tokenType,
    scope: auth.scope,
    auth_source: "local_pkce",
    token_exchange_location: "local",
  };
  Object.keys(metadata).forEach((key) => metadata[key] === undefined && delete metadata[key]);
  if (credentialId) {
    await api(`/credentials/${encodeURIComponent(credentialId)}`, {
      method: "PATCH",
      body: JSON.stringify({ secret: auth.accessToken, refreshToken: auth.refreshToken, expiresAt: auth.expiresAt ?? null, metadata }),
    });
    return credentialId;
  }
  const result = await api("/auth-files/import", {
    method: "POST",
    body: JSON.stringify({
      providerId,
      label,
      authType: "oauth",
      auth: {
        access_token: auth.accessToken,
        refresh_token: auth.refreshToken,
        id_token: auth.idToken,
        account_id: auth.accountId,
        email: auth.email,
        expires_at: auth.expiresAt,
        token_type: auth.tokenType,
        scope: auth.scope,
        auth_source: "local_pkce",
        token_exchange_location: "local",
      },
    }),
  });
  return result.id;
}
async function providerConfig() {
  const result = await api("/providers", { method: "GET" });
  const row = (result.data || []).find((item) => item.id === providerId);
  if (!row) throw new Error(`未找到供应商 ${providerId}`);
  let auth = {};
  try { auth = JSON.parse(row.auth_json || "{}"); } catch {}
  return { row, auth };
}
async function login() {
  const { row, auth } = await providerConfig();
  const issuer = String(auth.issuer || "https://auth.openai.com").replace(/\/$/, "");
  const authorizeUrl = String(auth.authorize_url || `${issuer}/oauth/authorize`);
  const tokenUrl = String(auth.token_url || `${issuer}/oauth/token`);
  const clientId = String(auth.client_id || "app_EMoamEEZ73f0CkXaXp7hrann");
  const preferredPort = Number(arg("port", 1455));
  const ports = [preferredPort, 1457].filter((value, index, array) => Number.isInteger(value) && value > 0 && array.indexOf(value) === index);
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(32));
  let server;
  let port;
  for (const candidate of ports) {
    try {
      server = http.createServer();
      await new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(candidate, "127.0.0.1", () => resolvePromise());
      });
      port = candidate;
      break;
    } catch { try { server?.close(); } catch {} }
  }
  if (!server || !port) throw new Error("无法监听 127.0.0.1:1455 或 1457，请关闭占用端口的程序");
  const redirectUri = `http://localhost:${port}/auth/callback`;
  const url = new URL(authorizeUrl);
  const scopes = Array.isArray(auth.scopes) && auth.scopes.length ? auth.scopes.join(" ") : "openid profile email offline_access api.connectors.read api.connectors.invoke";
  const params = {
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: scopes,
    code_challenge: challenge, code_challenge_method: "S256", state,
    id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "codex_cli_rs",
  };
  for (const [key, value] of Object.entries(auth)) if (key.startsWith("authorize_param_") && typeof value === "string") params[key.slice(16)] = value;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  console.log(`CFlareAIProxy Codex 本地授权\n供应商：${row.name}\n回调：${redirectUri}\n打开：${url}`);
  const completion = new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("OAuth 登录等待超时")), 10 * 60 * 1000);
    server.on("request", async (request, response) => {
      const callback = new URL(request.url || "/", redirectUri);
      if (callback.pathname === "/cancel") { response.end("cancelled"); clearTimeout(timer); reject(new Error("OAuth 登录已取消")); return; }
      if (callback.pathname !== "/auth/callback") { response.writeHead(404); response.end("Not found"); return; }
      try {
        if (callback.searchParams.get("state") !== state) throw new Error("OAuth state 不匹配");
        const oauthError = callback.searchParams.get("error");
        if (oauthError) throw new Error(callback.searchParams.get("error_description") || oauthError);
        const code = callback.searchParams.get("code");
        if (!code) throw new Error("回调缺少 code");
        const payload = await exchangeToken(tokenUrl, new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }));
        const authData = normalizedAuth(payload);
        const label = arg("label", authData.email ? `Codex · ${authData.email}` : `Codex · ${authData.accountId || "local OAuth"}`);
        const credentialId = await uploadAuth(authData, label);
        const target = resolve(arg("save", join(authDir, `codex-${safeName(authData.email || authData.accountId)}.json`)));
        saveAuth(authData, credentialId, target);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end("<meta charset=utf-8><h1>Codex 授权完成</h1><p>Token 已安全导入 CFlareAIProxy，可以关闭此窗口。</p>");
        clearTimeout(timer);
        resolvePromise({ credentialId, target, authData });
      } catch (error) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end(error instanceof Error ? error.message : String(error));
        clearTimeout(timer); reject(error);
      }
    });
  });
  openBrowser(url.toString());
  const result = await completion.finally(() => server.close());
  console.log(`✓ Codex 凭据已导入：${result.credentialId}\n✓ 本地受限权限授权副本：${result.target}\n提示：该文件含 refresh token，已加入 .gitignore，请妥善保护。`);
}
async function syncAuthFile({ watch = false } = {}) {
  const defaultPath = join(homedir(), ".codex", "auth.json");
  const source = resolve(arg("file", defaultPath));
  const intervalSeconds = Math.max(5, Number(arg("interval", 60)) || 60);
  const target = resolve(arg("save", join(authDir, "codex-sync.json")));
  let lastFingerprint = "";
  let credentialId = arg("credential", undefined);
  if (!credentialId && existsSync(target)) {
    try { credentialId = JSON.parse(readFileSync(target, "utf8")).credential_id; } catch {}
  }

  const syncOnce = async (announce = true) => {
    if (!existsSync(source)) throw new Error(`找不到授权文件：${source}`);
    const raw = JSON.parse(readFileSync(source, "utf8"));
    const auth = normalizedAuth(raw);
    const fingerprint = createHash("sha256").update(`${auth.accessToken}\0${auth.refreshToken || ""}`).digest("hex");
    if (fingerprint === lastFingerprint) return false;
    const label = arg("label", auth.email ? `Codex · ${auth.email}` : `Codex sync · ${basename(source)}`);
    credentialId = await uploadAuth(auth, label, credentialId || raw.credential_id);
    saveAuth(auth, credentialId, target);
    lastFingerprint = fingerprint;
    if (announce) console.log(`✓ 已同步 Codex 授权：${credentialId}\n✓ CFlareAIProxy 同步状态：${target}`);
    return true;
  };

  await syncOnce(true);
  if (!watch) {
    console.warn("注意：refresh token 可能轮换。重复运行该命令会更新同一账号，不会创建重复凭据。");
    return;
  }

  console.log(`正在监视 ${source}\n每 ${intervalSeconds} 秒检查一次；官方 Codex CLI 刷新 Token 后会自动同步到 CFlareAIProxy。按 Ctrl+C 停止。`);
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  while (!stopping) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalSeconds * 1000));
    if (stopping) break;
    try {
      if (await syncOnce(false)) console.log(`✓ ${new Date().toLocaleString()} Token 变化已同步`);
    } catch (error) {
      console.error(`! ${new Date().toLocaleString()} 同步失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log("Codex Token 监视已停止。");
}
async function importFile() { return syncAuthFile({ watch: false }); }
async function watchFile() { return syncAuthFile({ watch: true }); }
function defaultRefreshSource() {
  const explicit = arg("file", undefined);
  if (explicit) return resolve(explicit);
  const syncState = join(authDir, "codex-sync.json");
  if (existsSync(syncState)) return syncState;
  if (existsSync(authDir)) {
    const candidates = readdirSync(authDir)
      .filter((name) => /^codex-.+\.json$/i.test(name) && name !== "codex-sync.json")
      .sort();
    if (candidates.length === 1) return join(authDir, candidates[0]);
    if (candidates.length > 1) {
      throw new Error(`发现多个 Codex 授权副本，请使用 --file 指定：${candidates.join(", ")}`);
    }
  }
  return syncState;
}
async function refreshFile() {
  const source = defaultRefreshSource();
  if (!existsSync(source)) throw new Error(`找不到 CFlareAIProxy Codex 授权副本：${source}。请先运行 codex:login / codex:sync，或使用 --file 指定。`);
  const raw = JSON.parse(readFileSync(source, "utf8"));
  const auth = normalizedAuth(raw);
  if (!auth.refreshToken) throw new Error("授权文件没有 refresh_token");
  const { auth: providerAuth } = await providerConfig();
  const tokenUrl = String(providerAuth.token_url || "https://auth.openai.com/oauth/token");
  const clientId = String(providerAuth.client_id || "app_EMoamEEZ73f0CkXaXp7hrann");
  const payload = await exchangeToken(tokenUrl, new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: auth.refreshToken, scope: "openid profile email" }));
  const refreshed = normalizedAuth({ ...payload, id_token: payload.id_token || auth.idToken, refresh_token: payload.refresh_token || auth.refreshToken });
  const credentialId = arg("credential", raw.credential_id);
  if (!credentialId) throw new Error("授权副本没有 credential_id，请用 --credential 指定");
  await uploadAuth(refreshed, "", credentialId);
  saveAuth(refreshed, credentialId, source);
  console.log(`✓ Codex Token 已在本机刷新并同步到 CFlareAIProxy：${credentialId}`);
}

try {
  if (command === "login") await login();
  else if (command === "import") await importFile();
  else if (command === "refresh") await refreshFile();
  else if (command === "sync") await syncAuthFile({ watch: false });
  else if (command === "watch") await watchFile();
  else fail(`未知命令 ${command}。可用：login / import / refresh / sync / watch`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
