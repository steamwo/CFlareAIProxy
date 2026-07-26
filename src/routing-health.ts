import type { Env, ModelRouteRow } from "./types";
import { parseJson, truncate } from "./utils";

export interface ProviderHealthState {
  providerId: string;
  failures: number;
  disabledUntil: number;
  lastStatus?: number;
  lastError?: string;
  updatedAt: number;
}

/**
 * KV mirror payload: the public state plus the rolling failure window that is only
 * used when the account pool Durable Object cannot supply an atomic counter.
 */
interface StoredHealthState extends ProviderHealthState {
  window?: number[];
}

export const FAILURE_THRESHOLD = 3;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;
/** Failures older than this stop counting towards the breaker. */
const FAILURE_WINDOW_MS = 10 * 60_000;
const MAX_WINDOW_ENTRIES = 12;
const STATE_TTL_SECONDS = 24 * 60 * 60;
/** Skip mirroring to KV when the recomputed breaker deadline barely moved. */
const MIRROR_DRIFT_MS = 5_000;
/** How long an isolate trusts its own last write over a (possibly lagging) KV read. */
const MEMO_TRUST_MS = 60_000;
const MEMO_CAPACITY = 256;

const key = (providerId: string) => `provider-health:v1:${providerId}`;

/**
 * Isolate-local view of the last state this isolate wrote. Purely a cache that
 * compensates for KV read lag; entries expire after MEMO_TRUST_MS so a peer
 * isolate (or the admin console) stays able to change the authoritative state.
 */
const mirrorMemo = new Map<string, StoredHealthState>();
/**
 * Failure timestamps observed by this isolate, appended synchronously so that
 * concurrent fallback-path failures cannot lose counts to a read-modify-write race
 * (JS is single threaded, so the append happens before any await can interleave).
 */
const localWindows = new Map<string, number[]>();

function memoSet<T>(memo: Map<string, T>, providerId: string, value: T): void {
  if (memo.size >= MEMO_CAPACITY && !memo.has(providerId)) memo.clear();
  memo.set(providerId, value);
}

/** Test seam: drops isolate-local caches and re-arms Durable Object probing. */
export function resetRoutingHealthMemo(): void {
  mirrorMemo.clear();
  localWindows.clear();
  poolHealthSupported = true;
}

/** Appends `now` to this isolate's window and returns the pruned result. */
function noteLocalFailure(providerId: string, now: number): number[] {
  const window = [...(localWindows.get(providerId) ?? []).filter((entry) => entry > now - FAILURE_WINDOW_MS), now]
    .slice(-MAX_WINDOW_ENTRIES);
  memoSet(localWindows, providerId, window);
  return window;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(source: Record<string, unknown>, field: string): number | undefined {
  const value = source[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeStored(providerId: string, value: unknown): StoredHealthState | null {
  if (!isRecord(value)) return null;
  const lastStatus = numberField(value, "lastStatus");
  const lastError = typeof value.lastError === "string" ? value.lastError : undefined;
  const rawWindow = value.window;
  const window = Array.isArray(rawWindow)
    ? rawWindow.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
    : undefined;
  return {
    providerId,
    failures: Math.max(0, Math.trunc(numberField(value, "failures") ?? 0)),
    disabledUntil: Math.max(0, numberField(value, "disabledUntil") ?? 0),
    ...(lastStatus === undefined ? {} : { lastStatus }),
    ...(lastError === undefined ? {} : { lastError }),
    updatedAt: numberField(value, "updatedAt") ?? 0,
    ...(window === undefined ? {} : { window }),
  };
}

function publicState(state: StoredHealthState): ProviderHealthState {
  const { window: _window, ...rest } = state;
  return rest;
}

/** Prefer this isolate's own recent write over a KV read that may still be lagging. */
function freshest(stored: StoredHealthState | null, memo: StoredHealthState | undefined, now: number): StoredHealthState | null {
  if (!memo || now - memo.updatedAt > MEMO_TRUST_MS) return stored;
  if (!stored) return memo;
  return memo.updatedAt >= stored.updatedAt ? memo : stored;
}

/** Exponential backoff from the failure count: 30s doubling per extra failure, capped at 15 minutes. */
export function backoffMsForFailures(failures: number): number {
  if (failures < FAILURE_THRESHOLD) return 0;
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(5, failures - FAILURE_THRESHOLD));
}

async function readState(env: Env, providerId: string, now: number): Promise<StoredHealthState | null> {
  const raw = await env.CONFIG_CACHE.get(key(providerId), "text").catch(() => null);
  return freshest(normalizeStored(providerId, parseJson<unknown>(raw, null)), mirrorMemo.get(providerId), now);
}

export async function getProviderHealth(env: Env, providerId: string): Promise<ProviderHealthState | null> {
  const state = await readState(env, providerId, Date.now());
  return state ? publicState(state) : null;
}

export async function getProviderHealthMap(env: Env, providerIds: string[]): Promise<Record<string, ProviderHealthState | null>> {
  const unique = [...new Set(providerIds)];
  return Object.fromEntries(await Promise.all(unique.map(async (providerId) => [providerId, await getProviderHealth(env, providerId)] as const)));
}

interface PoolHealthResult {
  failures: number;
  disabledUntil: number;
}

/**
 * The account pool DO is the strongly consistent counter. Older deployments do not
 * expose /health/*, so the first 404 latches this isolate onto the KV fallback.
 */
let poolHealthSupported = true;

async function callPoolHealth(
  env: Env,
  providerId: string,
  path: "/health/failure" | "/health/reset",
  payload: Record<string, unknown>,
): Promise<PoolHealthResult | null> {
  if (!poolHealthSupported) return null;
  try {
    const namespace = env.ACCOUNT_POOL;
    const stub = namespace.get(namespace.idFromName(providerId));
    const response = await stub.fetch(`https://do.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (response.status === 404) {
      poolHealthSupported = false;
      return null;
    }
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    if (!isRecord(parsed)) return null;
    const failures = numberField(parsed, "failures");
    if (failures === undefined) return null;
    return { failures: Math.max(0, Math.trunc(failures)), disabledUntil: Math.max(0, numberField(parsed, "disabledUntil") ?? 0) };
  } catch {
    return null;
  }
}

/**
 * Fallback counter for when the DO is unavailable. A timestamp window keeps the
 * time-window semantics even when a concurrent writer overwrites this update, and
 * it ages failures out instead of pinning the breaker to a stale counter.
 */
function countFailureLocally(
  previous: StoredHealthState | null,
  localWindow: number[],
  now: number,
): { failures: number; window: number[] } {
  const stored = previous?.window
    ?? (previous && previous.failures > 0
      ? Array.from({ length: Math.min(previous.failures, MAX_WINDOW_ENTRIES) }, () => previous.updatedAt)
      : []);
  // The stored window may already contain this isolate's own entries, so the two
  // sources are not concatenated. Taking the longer window keeps time-window
  // semantics while guaranteeing at least this isolate's un-raced local count.
  const storedPruned = stored.filter((timestamp) => timestamp > now - FAILURE_WINDOW_MS).slice(-MAX_WINDOW_ENTRIES);
  const window = localWindow.length >= storedPruned.length ? localWindow : storedPruned;
  return { failures: Math.max(1, window.length), window };
}

function shouldMirror(previous: StoredHealthState | null, next: StoredHealthState): boolean {
  if (!previous) return true;
  if (previous.disabledUntil <= 0 && next.disabledUntil > 0) return true;
  if (Math.abs(next.disabledUntil - previous.disabledUntil) > MIRROR_DRIFT_MS) return true;
  // While the breaker is closed the admin console shows the raw failure count.
  return next.disabledUntil <= 0 && next.failures !== previous.failures;
}

export async function recordProviderFailure(
  env: Env,
  providerId: string,
  status: number | undefined,
  error: string,
): Promise<ProviderHealthState> {
  const now = Date.now();
  // Recorded before any await so concurrent failures in this isolate all count.
  const localWindow = noteLocalFailure(providerId, now);
  const previous = await readState(env, providerId, now);
  const atomic = await callPoolHealth(env, providerId, "/health/failure", {
    providerId,
    now,
    windowMs: FAILURE_WINDOW_MS,
    threshold: FAILURE_THRESHOLD,
    baseBackoffMs: BASE_BACKOFF_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
  });
  const local = atomic ? undefined : countFailureLocally(previous, localWindow, now);
  const failures = atomic?.failures ?? local?.failures ?? 1;
  const backoff = backoffMsForFailures(failures);
  const state: StoredHealthState = {
    providerId,
    failures,
    disabledUntil: Math.max(backoff > 0 ? now + backoff : 0, atomic?.disabledUntil ?? 0),
    lastStatus: status,
    lastError: truncate(error, 500),
    updatedAt: now,
    ...(local === undefined ? {} : { window: local.window }),
  };
  if (shouldMirror(previous, state)) {
    // Seed the memo before awaiting so concurrent failures in this isolate collapse
    // into a single KV write instead of one write each.
    memoSet(mirrorMemo, providerId, state);
    await env.CONFIG_CACHE.put(key(providerId), JSON.stringify(state), { expirationTtl: STATE_TTL_SECONDS }).catch(() => undefined);
  }
  return publicState(state);
}

/**
 * Clears the breaker. The steady-state hot path costs one KV read and no KV write:
 * a healthy provider has no stored state, so there is nothing to delete. Pass
 * `force` to clear unconditionally without the probe read.
 */
export async function recordProviderSuccess(env: Env, providerId: string, options: { force?: boolean } = {}): Promise<void> {
  if (!options.force) {
    const previous = await readState(env, providerId, Date.now());
    // Nothing recorded means the breaker is already closed: no write, no DO hop.
    if (!previous || (previous.failures === 0 && previous.disabledUntil === 0)) return;
  }
  mirrorMemo.delete(providerId);
  localWindows.delete(providerId);
  await Promise.all([
    env.CONFIG_CACHE.delete(key(providerId)).catch(() => undefined),
    callPoolHealth(env, providerId, "/health/reset", { providerId }),
  ]);
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
