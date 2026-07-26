export const QODER_PROVIDER_ID = "qoder";

export function discoveryCredentialScopes(providerKind: string, credentialId: string): string[] {
  return providerKind === QODER_PROVIDER_ID ? [credentialId, ""] : [credentialId];
}

export function publicDiscoveredModelId(
  providerKind: string,
  providerId: string,
  modelId: string,
  displayName: string,
): string {
  if (providerKind !== QODER_PROVIDER_ID) return `${providerId}/${modelId}`;
  return displayName.trim() || modelId;
}

export function discoveredModelAllowed(
  model: Record<string, unknown>,
  allowedModels: ReadonlySet<string>,
): boolean {
  if (allowedModels.has(String(model.id))) return true;
  if (model.x_cflare_provider !== QODER_PROVIDER_ID) return false;
  const upstreamModel = model.x_cflare_upstream_model;
  return typeof upstreamModel === "string" && allowedModels.has(`${QODER_PROVIDER_ID}/${upstreamModel}`);
}

export function normalizeAllowedModelNames(
  allowedModels: readonly string[],
  qoderAliases: ReadonlyMap<string, string>,
): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  const legacyPrefix = `${QODER_PROVIDER_ID}/`;
  for (const raw of allowedModels) {
    const value = raw.trim();
    if (!value) continue;
    const upstreamModel = value.startsWith(legacyPrefix) ? value.slice(legacyPrefix.length) : "";
    const normalized = upstreamModel ? qoderAliases.get(upstreamModel)?.trim() || value : value;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

export function sortModelRoutes<T extends { priority: number; weight: number; created_at: number }>(routes: T[]): T[] {
  return [...routes].sort((left, right) =>
    left.priority - right.priority
    || right.weight - left.weight
    || left.created_at - right.created_at,
  );
}
