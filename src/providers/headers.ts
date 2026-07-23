import type { Credential, ProviderConfig } from "../types";
import { decodeJwtPayload, pickString } from "../utils";

export function codexAccountId(credential: Credential): string | undefined {
  const metadataId = credential.metadata.account_id;
  if (typeof metadataId === "string" && metadataId) return metadataId;
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
    headers.set("originator", headers.get("originator") ?? "codex_cli_rs");
    headers.set("user-agent", headers.get("user-agent") ?? "codex_cli_rs");
    const accountId = codexAccountId(credential);
    if (accountId) headers.set("chatgpt-account-id", accountId);
  }
  return headers;
}
