import type { Credential, ProviderConfig } from "../types";
import { decodeJwtPayload, pickString } from "../utils";

const CODEX_USER_AGENT = "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal";

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

export function providerAuthHeaders(provider: ProviderConfig, credential: Credential): Headers {
  const headers = new Headers(provider.headers);
  const authHeader = typeof provider.auth.header === "string" ? provider.auth.header : "authorization";
  const authPrefix = typeof provider.auth.prefix === "string" ? provider.auth.prefix : "Bearer ";
  if (credential.secret) headers.set(authHeader, `${authPrefix}${credential.secret}`);

  const metadataHeaders = credential.metadata.headers;
  if (metadataHeaders && typeof metadataHeaders === "object" && !Array.isArray(metadataHeaders)) {
    for (const [key, value] of Object.entries(metadataHeaders as Record<string, unknown>)) {
      if (typeof value === "string") headers.set(key, value);
    }
  }

  if (provider.kind === "codex") {
    headers.set("authorization", `Bearer ${credential.secret}`);
    headers.set("accept", headers.get("accept") ?? "application/json");
    headers.set("content-type", headers.get("content-type") ?? "application/json");
    headers.set("originator", headers.get("originator") ?? "codex_cli_rs");
    headers.set("user-agent", CODEX_USER_AGENT);
    const accountId = codexAccountId(credential);
    if (accountId) headers.set("Chatgpt-Account-Id", accountId);
  }
  return headers;
}
