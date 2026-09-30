import type { Credential } from "./types";
import { decodeJwtPayload } from "./utils";

function safeEpochSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

export function jwtAccessTokenExpiry(token: string): number | undefined {
  if (!token || token.split(".").length < 3) return undefined;
  return safeEpochSeconds(decodeJwtPayload(token).exp);
}

/** JWT exp is authoritative when present; persisted metadata is a fallback only. */
export function credentialAccessTokenExpiry(credential: Pick<Credential, "secret" | "expires_at">): number | undefined {
  return jwtAccessTokenExpiry(credential.secret) ?? safeEpochSeconds(credential.expires_at);
}

export function credentialAccessTokenUsable(
  credential: Pick<Credential, "secret" | "expires_at">,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const expiry = credentialAccessTokenExpiry(credential);
  return expiry === undefined || expiry > now;
}

export function credentialNeedsRefresh(
  credential: Pick<Credential, "secret" | "expires_at">,
  leadSeconds: number,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const expiry = credentialAccessTokenExpiry(credential);
  return expiry !== undefined && expiry <= now + Math.max(0, Math.floor(leadSeconds));
}