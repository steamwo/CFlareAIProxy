import { CODEX_CLIENT_VERSION } from "../builtin-channels";
import type { Credential, ProviderConfig } from "../types";
import { decodeJwtPayload, pickString, resolveConfiguredHeaderValue } from "../utils";

const CODEX_USER_AGENT_SUFFIX = "(Debian 13.0.0; x86_64) WindowsTerminal";

function codexClientVersion(provider: ProviderConfig): string {
  const configured = provider.options.codex_client_version;
  return typeof configured === "string" && configured.trim() ? configured.trim() : CODEX_CLIENT_VERSION;
}

export function disableCodexCloaking(provider: ProviderConfig): boolean {
  return provider.options.disable_codex_cloaking === true
    || provider.options.disableCodexCloaking === true
    || provider.options.codex_preserve_identity_headers === true
    || provider.options.codexPreserveIdentityHeaders === true;
}

export function codexAccountId(credential: Credential): string | undefined {
  const metadataId = credential.metadata.account_id;
  if (typeof metadataId === "string" && metadataId) return metadataId;

  const metadataIdToken = credential.metadata.id_token;
  if (typeof metadataIdToken === "string" && metadataIdToken) {
    const idToken = decodeJwtPayload(metadataIdToken);
    const idTokenAuth = idToken["https://api.openai.com/auth"];
    if (idTokenAuth && typeof idTokenAuth === "object") {
      const id = (idTokenAuth as Record<string, unknown>).chatgpt_account_id;
      if (typeof id === "string" && id) return id;
    }
  }

  const access = decodeJwtPayload(credential.secret);
  const account = access["https://api.openai.com/auth"];
  if (account && typeof account === "object") {
    const id = (account as Record<string, unknown>).chatgpt_account_id;
    if (typeof id === "string" && id) return id;
  }
  return pickString(access, ["chatgpt_account_id", "account_id"]);
}

export function providerAuthHeaders(provider: ProviderConfig, credential: Credential, incomingHeaders?: Headers): Headers {
  const headers = new Headers();
  for (const [key, configured] of Object.entries(provider.headers)) {
    const value = resolveConfiguredHeaderValue(configured, incomingHeaders);
    if (value !== undefined) headers.set(key, value);
  }

  const authHeader = typeof provider.auth.header === "string" ? provider.auth.header : "authorization";
  const authPrefix = typeof provider.auth.prefix === "string" ? provider.auth.prefix : "Bearer ";
  if (credential.secret) headers.set(authHeader, `${authPrefix}${credential.secret}`);
  else headers.delete(authHeader);

  const metadataHeaders = credential.metadata.headers;
  if (metadataHeaders && typeof metadataHeaders === "object" && !Array.isArray(metadataHeaders)) {
    for (const [key, configured] of Object.entries(metadataHeaders as Record<string, unknown>)) {
      if (typeof configured !== "string") continue;
      const value = resolveConfiguredHeaderValue(configured, incomingHeaders);
      if (value !== undefined) headers.set(key, value);
      else headers.delete(key);
    }
  }

  if (provider.kind === "codex") {
    // Authentication and account identity are protected regardless of the transmitted
    // client identity policy. Empty config credentials must not leak a stale/custom
    // authorization value to a custom Codex-compatible upstream.
    if (credential.secret) headers.set("authorization", `Bearer ${credential.secret}`);
    else headers.delete("authorization");
    headers.set("accept", headers.get("accept") ?? "application/json");
    headers.set("content-type", headers.get("content-type") ?? "application/json");
    if (!disableCodexCloaking(provider)) {
      headers.set("originator", headers.get("originator") ?? "codex_cli_rs");
      headers.set("user-agent", `codex_cli_rs/${codexClientVersion(provider)} ${CODEX_USER_AGENT_SUFFIX}`);
    }
    const accountId = codexAccountId(credential);
    if (accountId) headers.set("Chatgpt-Account-Id", accountId);
    else headers.delete("Chatgpt-Account-Id");
  }
  return headers;
}
