import type { Env, ModelRouteRow } from "./types";

export interface ProviderHealthState {
  providerId: string;
  failures: number;
  disabledUntil: number;
  lastStatus?: number;
  lastError?: string;
  updatedAt: number;
}

const key = (providerId: string) => `provider-health:v1:${providerId}`;

export async function getProviderHealth(env: Env, providerId: string): Promise<ProviderHealthState | null> {
  return env.CONFIG_CACHE.get(key(providerId), "json").catch(() => null) as Promise<ProviderHealthState | null>;
}

export async function getProviderHealthMap(env: Env, providerIds: string[]): Promise<Record<string, ProviderHealthState | null>> {
  const unique = [...new Set(providerIds)];
  return Object.fromEntries(await Promise.all(unique.map(async (providerId) => [providerId, await getProviderHealth(env, providerId)] as const)));
}

export async function recordProviderFailure(
  env: Env,
  providerId: string,
  status: number | undefined,
  error: string,
): Promise<ProviderHealthState> {
  const now = Date.now();
  const previous = await getProviderHealth(env, providerId);
  const failures = (previous?.failures ?? 0) + 1;
  const disabledUntil = failures >= 3
    ? now + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(5, failures - 3))
    : 0;
  const state: ProviderHealthState = {
    providerId,
    failures,
    disabledUntil,
    lastStatus: status,
    lastError: error.slice(0, 500),
    updatedAt: now,
  };
  await env.CONFIG_CACHE.put(key(providerId), JSON.stringify(state), { expirationTtl: 24 * 60 * 60 }).catch(() => undefined);
  return state;
}

export async function recordProviderSuccess(env: Env, providerId: string): Promise<void> {
  await env.CONFIG_CACHE.delete(key(providerId)).catch(() => undefined);
}

function randomUnit(): number {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return bytes[0]! / 0x1_0000_0000;
}

function weightedShuffle(routes: ModelRouteRow[]): ModelRouteRow[] {
  const remaining = [...routes];
  const output: ModelRouteRow[] = [];
  while (remaining.length) {
    const total = remaining.reduce((sum, route) => sum + Math.max(1, route.weight), 0);
    let cursor = randomUnit() * total;
    let selected = 0;
    for (let index = 0; index < remaining.length; index += 1) {
      cursor -= Math.max(1, remaining[index]!.weight);
      if (cursor <= 0) { selected = index; break; }
    }
    output.push(remaining.splice(selected, 1)[0]!);
  }
  return output;
}

export async function orderHealthyRoutes(
  env: Env,
  routes: ModelRouteRow[],
): Promise<{ routes: ModelRouteRow[]; health: Record<string, ProviderHealthState | null>; blockedUntil?: number }> {
  const health = await getProviderHealthMap(env, routes.map((route) => route.provider_id));
  const now = Date.now();
  const healthy = routes.filter((route) => (health[route.provider_id]?.disabledUntil ?? 0) <= now);
  const blockedUntil = healthy.length ? undefined : Math.min(...routes.map((route) => health[route.provider_id]?.disabledUntil ?? Number.POSITIVE_INFINITY));
  const source = healthy.length ? healthy : [];
  const priorities = [...new Set(source.map((route) => route.priority))].sort((a, b) => a - b);
  return {
    routes: priorities.flatMap((priority) => weightedShuffle(source.filter((route) => route.priority === priority))),
    health,
    blockedUntil: Number.isFinite(blockedUntil) ? blockedUntil : undefined,
  };
}
