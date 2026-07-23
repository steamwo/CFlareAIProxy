#!/usr/bin/env node
import http from "node:http";
import { execFile } from "node:child_process";
import process from "node:process";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const gateway = (arg("gateway", "http://localhost:8787") || "").replace(/\/$/, "");
const adminToken = arg("admin-token", process.env.ADMIN_TOKEN);
const provider = arg("provider", "codex");
if (!adminToken) {
  console.error("缺少 --admin-token 或 ADMIN_TOKEN 环境变量");
  process.exit(1);
}

async function api(path, body) {
  const response = await fetch(`${gateway}/admin/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": adminToken },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
  return payload;
}
function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(command, args, () => {});
}

const start = await api(`/oauth/${encodeURIComponent(provider)}/start`, {});
if (!start.authorizeUrl) throw new Error(`Provider ${provider} 不是 authorization-code flow`);
console.log(`OAuth session: ${start.sessionId}`);
console.log(`打开：${start.authorizeUrl}`);

const server = http.createServer(async (request, response) => {
  try {
    const callbackUrl = `http://localhost:1455${request.url}`;
    const result = await api(`/oauth/${encodeURIComponent(provider)}/exchange`, { sessionId: start.sessionId, callbackUrl });
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<h1>授权完成</h1><p>Credential ID: <code>${result.credentialId}</code></p><p>可以关闭此窗口。</p>`);
    console.log(`✓ OAuth 凭据已创建：${result.credentialId}`);
    setTimeout(() => server.close(), 200);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : String(error));
    console.error(error);
  }
});
server.listen(1455, "127.0.0.1", () => {
  console.log("等待 OAuth 回调：http://localhost:1455/auth/callback");
  openBrowser(start.authorizeUrl);
});
