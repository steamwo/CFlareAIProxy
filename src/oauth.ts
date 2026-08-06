import { decryptSecret, encryptSecret } from "./crypto";
import { createCredential, getProvider, updateCredentialTokens } from "./db";
import { GatewayError } from "./errors";
import type { Credential, Env, ProviderConfig } from "./types";
import { decodeJwtPayload, nowSeconds, parseJson, pickString, pkceChallenge, randomToken } from "./utils";
import { providerFetch } from "./upstream-fetch";

interface OAuthSessionRow {
  id: string;
  provider_id: string;
  state: string;
  flow: string;
  secret_ciphertext: string;
  payload_json: string;
  last_polled_at: number | null;
  expires_at: number;
  created_at: number;
}

interface OAuthSessionSecret {
  verifier?: string;
  nonce?: string;
  machineId?: string;
  deviceCode?: string;
  deviceId?: string;
  redirectUri?: string;
}

export interface OAuthStartResult {
  sessionId: string;
  flow: string;
  authorizeUrl?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
  redirectUri?: string;
  expiresAt: number;
  intervalSeconds?: number;
}

export interface OAuthPollResult {
  status: "pending" | "complete";
  credentialId?: string;
  message?: string;
  retryAfterSeconds?: number;
}

function stringValue(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(object: Record<string, unknown>, key: string): number | undefined {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function oauthEndpointError(
  provider: ProviderConfig,
  action: "exchange" | "refresh",
  status: number,
  payload: Record<string, unknown>,
): string {
  const detail = stringValue(payload, "error_description") ?? stringValue(payload, "error") ?? `HTTP ${status}`;
  if (provider.kind === "codex" && status === 403) {
    const command = action === "exchange" ? "pnpm run codex:login" : "pnpm run codex:refresh -- --file <本地授权副本>";
    return `Codex OAuth ${action === "exchange" ? "换取 Token" : "刷新 Token"}被 auth.openai.com 拒绝（403：${detail}）。请先为 Codex 渠道设置可用代理后重试；仍失败时可执行 ${command}，或从管理台导入授权 JSON。`;
  }
  return detail;
}

export const OAUTH_REFRESH_TIMEOUT_MS = 30_000;

export function oauthRefreshTransportError(
  provider: ProviderConfig,
  error: unknown,
  timeoutMs = OAUTH_REFRESH_TIMEOUT_MS,
): GatewayError {
  if (error instanceof GatewayError) {
    return new GatewayError(error.status, "OAUTH_REFRESH_FAILED", error.message, error.type);
  }
  const message = error instanceof Error ? error.message : String(error);
  const timedOut = (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))
    || /timed?\s*out|timeout/i.test(message);
  return new GatewayError(
    timedOut ? 504 : 502,
    "OAUTH_REFRESH_FAILED",
    timedOut
      ? `${provider.name} OAuth refresh timed out after ${timeoutMs} ms`
      : `${provider.name} OAuth refresh request failed: ${message}`,
    "upstream_error",
  );
}

function kimiHeaders(deviceId: string): Headers {
  return new Headers({
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
    "x-msh-platform": "CFlareAIProxy",
    "x-msh-version": "0.1.0",
    "x-msh-device-name": "cloudflare-worker",
    "x-msh-device-model": "Cloudflare Workers",
    "x-msh-device-id": deviceId,
  });
}

async function saveSession(
  env: Env,
  providerId: string,
  state: string,
  flow: string,
  secret: OAuthSessionSecret,
  payload: Record<string, unknown>,
  expiresAt: number,
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO oauth_sessions(id, provider_id, state, flow, secret_ciphertext, payload_json, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    providerId,
    state,
    flow,
    await encryptSecret(JSON.stringify(secret), env.MASTER_KEY),
    JSON.stringify(payload),
    expiresAt,
    nowSeconds(),
  ).run();
  return id;
}

async function readSession(env: Env, sessionIdOrState: string): Promise<{
  row: OAuthSessionRow;
  secret: OAuthSessionSecret;
  payload: Record<string, unknown>;
}> {
  const row = await env.DB.prepare("SELECT * FROM oauth_sessions WHERE (id = ? OR state = ?) AND expires_at > ?")
    .bind(sessionIdOrState, sessionIdOrState, nowSeconds())
    .first<OAuthSessionRow>();
  if (!row) throw new GatewayError(404, "OAUTH_SESSION_NOT_FOUND", "OAuth session was not found or has expired");
  // Sessions written just before a MASTER_KEY rotation must stay readable, otherwise an
  // authorization flow already in flight dies mid-callback with an opaque DECRYPT_FAILED.
  const secret = parseJson<OAuthSessionSecret>(
    await decryptSecret(row.secret_ciphertext, env.MASTER_KEY, env.MASTER_KEY_PREVIOUS),
    {},
  );
  return { row, secret, payload: parseJson<Record<string, unknown>>(row.payload_json, {}) };
}

async function deleteSession(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM oauth_sessions WHERE id = ?").bind(id).run();
}

function authorizationConfig(provider: ProviderConfig): {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
} {
  const authorizeUrl = stringValue(provider.auth, "authorize_url");
  const tokenUrl = stringValue(provider.auth, "token_url");
  const clientId = stringValue(provider.auth, "client_id");
  const redirectUri = stringValue(provider.auth, "redirect_uri");
  if (!authorizeUrl || !tokenUrl || !clientId || !redirectUri) {
    throw new GatewayError(400, "OAUTH_CONFIG_INVALID", `Provider ${provider.id} is missing OAuth authorization-code settings`);
  }
  const scopes = Array.isArray(provider.auth.scopes)
    ? provider.auth.scopes.filter((entry): entry is string => typeof entry === "string")
    : [];
  return { authorizeUrl, tokenUrl, clientId, redirectUri, scopes };
}

export async function startOAuth(env: Env, providerId: string): Promise<OAuthStartResult> {
  const provider = await getProvider(env, providerId);
  const flow = stringValue(provider.auth, "flow") ?? "authorization_code_pkce";
  const state = randomToken(24);

  if (flow === "device_code") {
    const deviceUrl = stringValue(provider.auth, "device_url");
    const clientId = stringValue(provider.auth, "client_id");
    if (!deviceUrl || !clientId) throw new GatewayError(400, "OAUTH_CONFIG_INVALID", "Device-flow provider is not configured");
    const deviceId = crypto.randomUUID();
    const body = new URLSearchParams({ client_id: clientId });
    const response = await providerFetch(env, provider, deviceUrl, {
      method: "POST",
      headers: kimiHeaders(deviceId),
      body,
    }, { purpose: "oauth", timeoutMs: 30_000 });
    const payload = await (response.json() as Promise<Record<string, unknown>>).catch(() => ({}));
    if (!response.ok) {
      throw new GatewayError(502, "OAUTH_DEVICE_START_FAILED", stringValue(payload, "error_description") ?? `OAuth device start failed: ${response.status}`);
    }
    const deviceCode = stringValue(payload, "device_code");
    if (!deviceCode) throw new GatewayError(502, "OAUTH_DEVICE_START_FAILED", "OAuth server did not return device_code");
    const expiresIn = numberValue(payload, "expires_in") ?? 900;
    const expiresAt = nowSeconds() + Math.min(3600, Math.max(60, expiresIn));
    const sessionId = await saveSession(env, provider.id, state, flow, { deviceCode, deviceId }, payload, expiresAt);
    return {
      sessionId,
      flow,
      verificationUri: stringValue(payload, "verification_uri"),
      verificationUriComplete: stringValue(payload, "verification_uri_complete"),
      userCode: stringValue(payload, "user_code"),
      expiresAt,
      intervalSeconds: Math.max(2, numberValue(payload, "interval") ?? 5),
    };
  }

  if (flow === "qoder_pkce_device") {
    const loginUrl = stringValue(provider.auth, "login_url");
    if (!loginUrl) throw new GatewayError(400, "OAUTH_CONFIG_INVALID", "Qoder login URL is not configured");
    const verifier = randomToken(48);
    const challenge = await pkceChallenge(verifier);
    const nonce = crypto.randomUUID();
    const machineId = crypto.randomUUID();
    const url = new URL(loginUrl);
    url.searchParams.set("challenge", challenge);
    url.searchParams.set("challenge_method", "S256");
    url.searchParams.set("machine_id", machineId);
    url.searchParams.set("nonce", nonce);
    const expiresAt = nowSeconds() + 10 * 60;
    const sessionId = await saveSession(env, provider.id, state, flow, { verifier, nonce, machineId }, {}, expiresAt);
    return { sessionId, flow, authorizeUrl: url.toString(), verificationUriComplete: url.toString(), expiresAt, intervalSeconds: 2 };
  }

  const config = authorizationConfig(provider);
  const verifier = randomToken(48);
  const challenge = await pkceChallenge(verifier);
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (config.scopes.length) url.searchParams.set("scope", config.scopes.join(" "));
  for (const [key, value] of Object.entries(provider.auth)) {
    if (key.startsWith("authorize_param_") && typeof value === "string") {
      url.searchParams.set(key.slice("authorize_param_".length), value);
    }
  }
  const expiresAt = nowSeconds() + 10 * 60;
  const sessionId = await saveSession(env, provider.id, state, flow, { verifier, redirectUri: config.redirectUri }, {}, expiresAt);
  return { sessionId, flow, authorizeUrl: url.toString(), redirectUri: config.redirectUri, expiresAt };
}

function tokenExpiry(payload: Record<string, unknown>): number | undefined {
  const expiresIn = numberValue(payload, "expires_in");
  if (expiresIn && expiresIn > 0) return nowSeconds() + Math.floor(expiresIn);
  const numericExpiresAt = numberValue(payload, "expires_at");
  if (numericExpiresAt) return numericExpiresAt > 10_000_000_000 ? Math.floor(numericExpiresAt / 1000) : Math.floor(numericExpiresAt);
  const expiresAt = stringValue(payload, "expires_at");
  if (expiresAt) {
    const numeric = Number(expiresAt);
    if (Number.isFinite(numeric) && numeric > 0) return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
    const parsed = Date.parse(expiresAt);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  const numeric = numberValue(payload, "expire_time");
  if (numeric) return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  return undefined;
}

function codexMetadata(
  payload: Record<string, unknown>,
  accessToken: string,
  previous: Record<string, unknown> = {},
): Record<string, unknown> {
  const idToken = stringValue(payload, "id_token")
    ?? (typeof previous.id_token === "string" ? previous.id_token : undefined);
  const claims = decodeJwtPayload(idToken ?? accessToken);
  const auth = record(claims["https://api.openai.com/auth"]);
  const metadata: Record<string, unknown> = {
    ...previous,
    id_token: idToken,
    account_id: pickString(auth, ["chatgpt_account_id"])
      ?? pickString(claims, ["chatgpt_account_id", "account_id"])
      ?? previous.account_id,
    email: pickString(claims, ["email"]) ?? previous.email,
    plan_type: pickString(auth, ["chatgpt_plan_type"]) ?? previous.plan_type,
    chatgpt_subscription_active_start: auth.chatgpt_subscription_active_start ?? previous.chatgpt_subscription_active_start,
    chatgpt_subscription_active_until: auth.chatgpt_subscription_active_until ?? previous.chatgpt_subscription_active_until,
    token_type: stringValue(payload, "token_type") ?? previous.token_type ?? "Bearer",
    scope: stringValue(payload, "scope") ?? previous.scope,
    last_refresh: new Date().toISOString(),
  };
  for (const key of Object.keys(metadata)) if (metadata[key] === undefined) delete metadata[key];
  return metadata;
}

function qoderPayloadRoot(payload: Record<string, unknown>): Record<string, unknown> {
  let current = payload;
  for (let depth = 0; depth < 3; depth += 1) {
    if (stringValue(current, "token") || stringValue(current, "access_token")) return current;
    const nested = current.data ?? current.result ?? current.payload;
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return current;
    current = nested as Record<string, unknown>;
  }
  return current;
}

async function fetchQoderUserInfo(env: Env, provider: ProviderConfig, token: string): Promise<Record<string, unknown>> {
  try {
    const response = await providerFetch(env, provider, "https://openapi.qoder.sh/api/v1/userinfo", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": "CFlareAIProxy/0.5.3" },
    }, { purpose: "oauth", timeoutMs: 20_000 });
    if (!response.ok) return {};
    return qoderPayloadRoot(await response.json() as Record<string, unknown>);
  } catch {
    return {};
  }
}

async function finalizeCredential(
  env: Env,
  provider: ProviderConfig,
  sessionId: string,
  payload: Record<string, unknown>,
  extraMetadata: Record<string, unknown> = {},
): Promise<OAuthPollResult> {
  const accessToken = stringValue(payload, "access_token") ?? stringValue(payload, "token");
  if (!accessToken) throw new GatewayError(502, "OAUTH_TOKEN_INVALID", "OAuth server returned no access token");
  const refreshToken = stringValue(payload, "refresh_token");
  const accessClaims = decodeJwtPayload(accessToken);
  const accessAuth = record(accessClaims["https://api.openai.com/auth"]);
  const baseMetadata: Record<string, unknown> = {
    token_type: stringValue(payload, "token_type") ?? "Bearer",
    scope: stringValue(payload, "scope"),
    account_id: pickString(accessAuth, ["chatgpt_account_id"])
      ?? pickString(accessClaims, ["chatgpt_account_id", "account_id"]),
    email: pickString(accessClaims, ["email"]),
    ...extraMetadata,
  };
  const metadata = provider.kind === "codex"
    ? { ...codexMetadata(payload, accessToken, baseMetadata), ...extraMetadata }
    : baseMetadata;
  for (const key of Object.keys(metadata)) if (metadata[key] === undefined) delete metadata[key];
  const label = typeof metadata.email === "string" ? `${provider.name} · ${metadata.email}` : `${provider.name} OAuth`;
  const credentialId = await createCredential(env, {
    providerId: provider.id,
    label,
    authType: "oauth",
    secret: accessToken,
    refreshToken,
    expiresAt: tokenExpiry(payload),
    metadata,
  });
  await deleteSession(env, sessionId);
  return { status: "complete", credentialId, message: "OAuth credential created" };
}

/**
 * Shortest gap the gateway will forward a poll upstream, in seconds.
 *
 * `intervalSeconds` in the start response is only advice — nothing stopped a client from
 * polling in a tight loop, which hammers the provider's device-code endpoint and pays for a
 * session read plus a decrypt on every iteration. This floor sits just under the smallest
 * interval we hand out (2s for Qoder) so a well-behaved console is never throttled by the
 * advice it was given, while a loop collapses to one upstream call per window.
 */
const POLL_MIN_INTERVAL_SECONDS = 2;

/**
 * Atomically claims the right to forward one poll upstream. The conditional UPDATE is the
 * synchronization point: concurrent requests may read the same session, but only one can
 * advance last_polled_at inside a window.
 */
async function claimPollSlot(env: Env, row: OAuthSessionRow, at: number): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE oauth_sessions SET last_polled_at=?
     WHERE id=? AND (last_polled_at IS NULL OR last_polled_at<=?)`,
  ).bind(at, row.id, at - POLL_MIN_INTERVAL_SECONDS).run();
  return Number(result.meta.changes ?? 0) > 0;
}

export async function pollOAuth(env: Env, providerId: string, sessionId: string): Promise<OAuthPollResult> {
  const provider = await getProvider(env, providerId);
  const session = await readSession(env, sessionId);
  if (session.row.provider_id !== providerId) throw new GatewayError(400, "OAUTH_PROVIDER_MISMATCH", "OAuth session belongs to another provider");

  const now = nowSeconds();
  if (!(await claimPollSlot(env, session.row, now))) {
    // Deliberately shaped like any other pending result: a caller that is polling too fast
    // learns only that authorization has not completed, which is also what it would have
    // learned from the upstream. Surfacing "you are rate limited" would tell an abuser
    // exactly how to pace itself.
    return { status: "pending", retryAfterSeconds: POLL_MIN_INTERVAL_SECONDS };
  }

  if (session.row.flow === "device_code") {
    const tokenUrl = stringValue(provider.auth, "token_url");
    const clientId = stringValue(provider.auth, "client_id");
    if (!tokenUrl || !clientId || !session.secret.deviceCode || !session.secret.deviceId) {
      throw new GatewayError(400, "OAUTH_SESSION_INVALID", "Device OAuth session is incomplete");
    }
    const body = new URLSearchParams({
      client_id: clientId,
      device_code: session.secret.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const response = await providerFetch(env, provider, tokenUrl, {
      method: "POST",
      headers: kimiHeaders(session.secret.deviceId),
      body,
    }, { purpose: "oauth", timeoutMs: 30_000 });
    const payload = await (response.json() as Promise<Record<string, unknown>>).catch(() => ({}));
    const oauthError = stringValue(payload, "error");
    if (oauthError === "authorization_pending" || oauthError === "slow_down") {
      return { status: "pending", retryAfterSeconds: oauthError === "slow_down" ? 8 : 5 };
    }
    if (!response.ok || oauthError) {
      throw new GatewayError(502, "OAUTH_TOKEN_FAILED", stringValue(payload, "error_description") ?? oauthError ?? `OAuth token endpoint returned ${response.status}`);
    }
    return finalizeCredential(env, provider, session.row.id, payload, { device_id: session.secret.deviceId });
  }

  if (session.row.flow === "qoder_pkce_device") {
    const pollUrl = stringValue(provider.auth, "poll_url");
    if (!pollUrl || !session.secret.nonce || !session.secret.verifier || !session.secret.machineId) {
      throw new GatewayError(400, "OAUTH_SESSION_INVALID", "Qoder OAuth session is incomplete");
    }
    const url = new URL(pollUrl);
    url.searchParams.set("nonce", session.secret.nonce);
    url.searchParams.set("verifier", session.secret.verifier);
    url.searchParams.set("challenge_method", "S256");
    const response = await providerFetch(env, provider, url, {
      headers: { accept: "application/json", "user-agent": "CFlareAIProxy/0.5.3" },
    }, { purpose: "oauth", timeoutMs: 20_000 });
    if (response.status === 202 || response.status === 404) {
      return { status: "pending", message: "等待 Qoder 完成授权…", retryAfterSeconds: 2 };
    }
    const payload = await (response.json() as Promise<Record<string, unknown>>).catch(() => ({}));
    const root = qoderPayloadRoot(payload);
    if (!response.ok) {
      throw new GatewayError(502, "OAUTH_TOKEN_FAILED", stringValue(root, "message") ?? stringValue(root, "msgInfo") ?? `Qoder OAuth returned ${response.status}`);
    }
    const token = stringValue(root, "token") ?? stringValue(root, "access_token");
    if (!token) throw new GatewayError(502, "OAUTH_TOKEN_INVALID", "Qoder OAuth response is missing token");
    const userInfo = await fetchQoderUserInfo(env, provider, token);
    const userId = stringValue(root, "user_id") ?? stringValue(root, "userId")
      ?? stringValue(userInfo, "id") ?? stringValue(userInfo, "user_id") ?? stringValue(userInfo, "userId");
    if (!userId) throw new GatewayError(502, "OAUTH_USERINFO_INVALID", "Qoder authorization succeeded, but user identity could not be resolved");
    return finalizeCredential(env, provider, session.row.id, root, {
      user_id: userId,
      machine_id: session.secret.machineId,
      name: stringValue(userInfo, "name") ?? stringValue(userInfo, "username"),
      email: stringValue(userInfo, "email"),
      organization_id: stringValue(userInfo, "organization_id") ?? stringValue(userInfo, "organizationId"),
      member_id: stringValue(userInfo, "member_id") ?? stringValue(userInfo, "memberId"),
    });
  }

  return { status: "pending", message: "Authorization-code flow requires callback exchange" };
}

export async function exchangeOAuthCode(
  env: Env,
  providerId: string,
  input: { sessionId?: string; state?: string; code?: string; callbackUrl?: string },
): Promise<OAuthPollResult> {
  let state = input.state;
  let code = input.code;
  if (input.callbackUrl) {
    const url = new URL(input.callbackUrl);
    state = state ?? url.searchParams.get("state") ?? undefined;
    code = code ?? url.searchParams.get("code") ?? undefined;
    const error = url.searchParams.get("error");
    if (error) throw new GatewayError(400, "OAUTH_DENIED", url.searchParams.get("error_description") ?? error);
  }
  const lookup = input.sessionId ?? state;
  if (!lookup || !code) throw new GatewayError(400, "OAUTH_CALLBACK_INVALID", "sessionId/state and code are required");
  const session = await readSession(env, lookup);
  if (state && session.row.state !== state) throw new GatewayError(400, "OAUTH_STATE_MISMATCH", "OAuth state did not match");
  if (session.row.provider_id !== providerId) throw new GatewayError(400, "OAUTH_PROVIDER_MISMATCH", "OAuth session belongs to another provider");
  const provider = await getProvider(env, providerId);
  const config = authorizationConfig(provider);
  if (!session.secret.verifier) throw new GatewayError(400, "OAUTH_SESSION_INVALID", "OAuth verifier is missing");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    redirect_uri: session.secret.redirectUri ?? config.redirectUri,
    code_verifier: session.secret.verifier,
  });
  const response = await providerFetch(env, provider, config.tokenUrl, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
  }, { purpose: "oauth", timeoutMs: 30_000 });
  const payload = await (response.json() as Promise<Record<string, unknown>>).catch(() => ({}));
  if (!response.ok) {
    throw new GatewayError(502, "OAUTH_TOKEN_FAILED", oauthEndpointError(provider, "exchange", response.status, payload));
  }
  return finalizeCredential(env, provider, session.row.id, payload);
}

export async function refreshCredential(env: Env, provider: ProviderConfig, credential: Credential): Promise<Credential> {
  if (!credential.refreshToken || !credential.expires_at || credential.expires_at > nowSeconds() + 300) return credential;
  let payload: Record<string, unknown>;
  if (provider.kind === "qoder") {
    const refreshUrl = stringValue(provider.auth, "refresh_url") ?? "https://center.qoder.sh/algo/api/v3/user/refresh_token";
    let response: Response;
    try {
      response = await providerFetch(env, provider, refreshUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${credential.secret}`, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: credential.refreshToken }),
      }, { purpose: "oauth", timeoutMs: OAUTH_REFRESH_TIMEOUT_MS });
    } catch (error) {
      throw oauthRefreshTransportError(provider, error);
    }
    payload = await (response.json() as Promise<Record<string, unknown>>).catch(() => ({}));
    if (!response.ok) return credential;
  } else {
    const tokenUrl = stringValue(provider.auth, "token_url");
    const clientId = stringValue(provider.auth, "client_id");
    if (!tokenUrl || !clientId) return credential;
    const values: Record<string, string> = {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: credential.refreshToken,
    };
    if (provider.kind === "codex") values.scope = "openid profile email";
    const body = new URLSearchParams(values);
    const headers = provider.kind === "kimi"
      ? kimiHeaders(typeof credential.metadata.device_id === "string" ? credential.metadata.device_id : crypto.randomUUID())
      : new Headers({ accept: "application/json", "content-type": "application/x-www-form-urlencoded" });
    let response: Response;
    try {
      response = await providerFetch(env, provider, tokenUrl, {
        method: "POST",
        headers,
        body,
      }, { purpose: "oauth", timeoutMs: OAUTH_REFRESH_TIMEOUT_MS });
    } catch (error) {
      throw oauthRefreshTransportError(provider, error);
    }
    payload = await (response.json() as Promise<Record<string, unknown>>).catch(() => ({}));
    if (!response.ok) throw new GatewayError(502, "OAUTH_REFRESH_FAILED", oauthEndpointError(provider, "refresh", response.status, payload));
  }
  const access = stringValue(payload, "access_token") ?? stringValue(payload, "token");
  if (!access) return credential;
  const refreshToken = stringValue(payload, "refresh_token") ?? credential.refreshToken;
  const expiresAt = tokenExpiry(payload) ?? credential.expires_at;
  const metadata = provider.kind === "codex"
    ? codexMetadata(payload, access, credential.metadata)
    : credential.metadata;
  await updateCredentialTokens(env, credential.id, access, refreshToken, expiresAt ?? undefined, metadata);
  return {
    ...credential,
    secret: access,
    refreshToken,
    expires_at: expiresAt,
    metadata,
  };
}
