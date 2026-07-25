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

export function sortModelRoutes<T extends { priority: number; weight: number; created_at: number }>(routes: T[]): T[] {
  return [...routes].sort((left, right) =>
    left.priority - right.priority
    || right.weight - left.weight
    || left.created_at - right.created_at,
  );
}
