import { updateCredentialTokens } from "./db";
import { GatewayError } from "./errors";
import { credentialProxyUrl, providerFetchForCredential } from "./credential-fetch";
import { refreshCredential } from "./oauth";
import type { Credential, Env, ProviderConfig } from "./types";
import { classifyUpstreamResponse, gatewayErrorFromClassification } from "./upstream-errors";

function stringValue(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(object: Record<string, unknown>, key: string): number | undefined {
  const value = object[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function tokenExpiry(payload: Record<string, unknown>): number | undefined {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = numberValue(payload, "expires_in");
  if (expiresIn && expiresIn > 0) return now + Math.floor(expiresIn);
  for (const key of ["expires_at", "expire_time"]) {
    const numeric = numberValue(payload, key);
    if (numeric && numeric > 0) return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
    const raw = stringValue(payload, key);
    if (!raw) continue;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return undefined;
}

function kimiHeaders(credential: Credential): Headers {
  const deviceId = typeof credential.metadata.device_id === "string" && credential.metadata.device_id.trim()
    ? credential.metadata.device_id.trim()
    : credential.id;
  return new Headers({
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
    "x-msh-platform": "CFlareAIProxy",
    "x-msh-version": "0.5.3",
    "x-msh-device-name": "cloudflare-worker",
    "x-msh-device-model": "Cloudflare Workers",
    "x-msh-device-id": deviceId,
  });
}

export async function refreshCredentialForInference(
  env: Env,
  provider: ProviderConfig,
  credential: Credential,
): Promise<Credential> {
  if (!credentialProxyUrl(credential)) return refreshCredential(env, provider, credential);
  if (provider.kind !== "kimi" && provider.kind !== "codex") return refreshCredential(env, provider, credential);
  if (!credential.refreshToken) return credential;
  const tokenUrl = stringValue(provider.auth, "token_url");
  const clientId = stringValue(provider.auth, "client_id");
  if (!tokenUrl || !clientId) return refreshCredential(env, provider, credential);

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: credential.refreshToken,
  });
  if (provider.kind === "codex") body.set("scope", "openid profile email");
  const headers = provider.kind === "kimi"
    ? kimiHeaders(credential)
    : new Headers({ accept: "application/json", "content-type": "application/x-www-form-urlencoded" });
  const response = await providerFetchForCredential(
    env,
    provider,
    credential,
    tokenUrl,
    { method: "POST", headers, body },
    { purpose: "oauth", timeoutMs: 30_000 },
  );
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try { payload = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* classified below */ }
  if (!response.ok) {
    throw gatewayErrorFromClassification(classifyUpstreamResponse(response.status, text, response.headers, provider.kind));
  }
  const accessToken = stringValue(payload, "access_token") ?? stringValue(payload, "token");
  if (!accessToken) throw new GatewayError(502, "OAUTH_REFRESH_INVALID", `${provider.name} refresh response did not include an access token`, "upstream_error");
  const refreshToken = stringValue(payload, "refresh_token") ?? credential.refreshToken;
  const expiresAt = tokenExpiry(payload) ?? credential.expires_at ?? undefined;
  await updateCredentialTokens(env, credential.id, accessToken, refreshToken, expiresAt, credential.metadata);
  return { ...credential, secret: accessToken, refreshToken, expires_at: expiresAt ?? credential.expires_at };
}
