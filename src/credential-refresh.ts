import { updateCredentialTokens } from "./db";
import { GatewayError } from "./errors";
import { credentialProxyUrl, providerFetchForCredential } from "./credential-fetch";
import { OAUTH_REFRESH_TIMEOUT_MS, oauthRefreshTransportError, refreshCredential } from "./oauth";
import { jwtAccessTokenExpiry } from "./token-expiry";
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
  requestProxyOverride?: string,
): Promise<Credential> {
  const requestOverride = requestProxyOverride?.trim() ?? "";
  if (!requestOverride && !credentialProxyUrl(credential)) return refreshCredential(env, provider, credential);
  if (!credential.refreshToken) return credential;

  let response: Response;
  if (provider.kind === "qoder") {
    const refreshUrl = stringValue(provider.auth, "refresh_url") ?? "https://center.qoder.sh/algo/api/v3/user/refresh_token";
    response = await providerFetchForCredential(
      env,
      provider,
      credential,
      refreshUrl,
      {
        method: "POST",
        headers: { authorization: `Bearer ${credential.secret}`, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: credential.refreshToken }),
      },
      { purpose: "oauth", timeoutMs: 30_000, requestProxyOverride: requestOverride || undefined },
    );
    if (!response.ok) return credential;
  } else {
    const tokenUrl = stringValue(provider.auth, "token_url");
    const clientId = stringValue(provider.auth, "client_id");
    if (!tokenUrl || !clientId) return credential;

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: credential.refreshToken,
    });
    if (provider.kind === "codex") body.set("scope", "openid profile email");
    const headers = provider.kind === "kimi"
      ? kimiHeaders(credential)
      : new Headers({ accept: "application/json", "content-type": "application/x-www-form-urlencoded" });
    if (provider.kind === "codex") {
      try {
        response = await providerFetchForCredential(
          env,
          provider,
          credential,
          tokenUrl,
          { method: "POST", headers, body },
          { purpose: "oauth", timeoutMs: OAUTH_REFRESH_TIMEOUT_MS, requestProxyOverride: requestOverride || undefined },
        );
      } catch (error) {
        throw oauthRefreshTransportError(provider, error);
      }
    } else {
      response = await providerFetchForCredential(
        env,
        provider,
        credential,
        tokenUrl,
        { method: "POST", headers, body },
        { purpose: "oauth", timeoutMs: 30_000, requestProxyOverride: requestOverride || undefined },
      );
    }
    if (!response.ok) {
      const text = await response.text();
      throw gatewayErrorFromClassification(classifyUpstreamResponse(response.status, text, response.headers, provider.kind));
    }
  }

  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try { payload = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* classified below */ }
  const accessToken = stringValue(payload, "access_token") ?? stringValue(payload, "token");
  if (!accessToken) throw new GatewayError(502, "OAUTH_REFRESH_INVALID", `${provider.name} refresh response did not include an access token`, "upstream_error");
  const refreshToken = stringValue(payload, "refresh_token") ?? credential.refreshToken;
  const expiresAt = jwtAccessTokenExpiry(accessToken) ?? tokenExpiry(payload) ?? credential.expires_at ?? undefined;
  await updateCredentialTokens(env, credential.id, accessToken, refreshToken, expiresAt, credential.metadata);
  return { ...credential, secret: accessToken, refreshToken, expires_at: expiresAt ?? credential.expires_at };
}