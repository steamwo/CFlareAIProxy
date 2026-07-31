import type { Env } from "./types";
import { normalizeBaseUrl } from "./utils";

function owns(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Credential fields that can change which upstream account or model catalogue is being used.
 * Routine access-token refreshes do not use this admin payload and therefore do not invalidate
 * discovery on every OAuth refresh.
 */
export function credentialUpdateInvalidatesModelDiscovery(body: Record<string, unknown>): boolean {
  return nonEmptyString(body.secret)
    || nonEmptyString(body.refreshToken)
    || owns(body, "metadata");
}

export function providerUpdateInvalidatesModelDiscovery(input: {
  currentBaseUrl: string;
  nextBaseUrl: string;
  currentApiMode: unknown;
  nextApiMode: string;
}): boolean {
  const currentMode = input.currentApiMode === "chat" || input.currentApiMode === "responses"
    ? input.currentApiMode
    : "both";
  return normalizeBaseUrl(input.currentBaseUrl) !== normalizeBaseUrl(input.nextBaseUrl)
    || currentMode !== input.nextApiMode;
}

export async function deleteCredentialModelDiscovery(env: Env, credentialId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM discovered_models WHERE credential_id=?")
    .bind(credentialId)
    .run();
}

export async function deleteProviderModelDiscovery(env: Env, providerId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM discovered_models WHERE provider_id=?")
    .bind(providerId)
    .run();
}
