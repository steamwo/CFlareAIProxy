import type { Context } from "hono";
import {
  isCodexMultiAgentClient, loadCodexMultiAgentModelProfiles, optimizeCodexMultiAgentV2Body,
} from "./codex-multi-agent-v2";
import { providerFetchForCredential } from "./credential-fetch";
import { authenticateGatewayKey, gatewayKeyAllowsModel, getCredential, getProvider, listCredentialAvailabilityForModel, listRoutesForModel, setCredentialError } from "./db";
import type { CredentialAvailability } from "./db";
import { GatewayError, errorResponse } from "./errors";
import { getLoggingSettings, normalizeLoggingSettings, runtimeLog, shouldPersistError } from "./logging-settings";
import { routeRuntimeOptions, validateModelCapabilities } from "./model-capabilities";
import type { RouteRuntimeOptions } from "./model-capabilities";
import { ensureOpenCodeAnonymousModels } from "./models";
import { refreshCredentialForInference } from "./credential-refresh";
import { prepareProviderResponse } from "./provider-response";
import { buildUpstreamRequest } from "./providers";
import { fetchOpenCodeWithFailover } from "./providers/opencode-failover";
import { isOpenCodeAnonymousCredential } from "./providers/opencode-anonymous";
import { captureQuotaHeaders } from "./quota";
import { orderHealthyRoutes, recordProviderFailure, recordProviderSuccess } from "./routing-health";
import { buildSessionAffinityKey } from "./session-affinity";
import { trackResponse } from "./stream";
import type { CredentialRow, Env, GatewayEndpoint, GatewayKeyRow, LoggingSettings, ModelRouteRow, PoolCandidate, PoolLease, ProviderConfig, RateLease, Usage, UsageEvent } from "./types";
import {
  classifyTransportError,
  classifyUpstreamResponse,
  credentialCooldownEligible,
  gatewayErrorFromClassification,
  providerFailureEligible,
} from "./upstream-errors";
import { asInt, parseJson, readJsonBody, truncate } from "./utils";

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) throw new GatewayError(401, "AUTHENTICATION_ERROR", "Missing Bearer API key", "authentication_error");
  return match[1].trim();
}

function estimateInputTokens(body: Record<string, unknown>): number {
  return Math.max(1, Math.ceil(JSON.stringify(body).length / 4));
}

async function postDo<T>(stub: DurableObjectStub, path: string, payload: unknown): Promise<T> {
  const response = await stub.fetch(`https://do.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result: Record<string, unknown> = await (response.json() as Promise<Record<string, unknown>>).catch(() => ({}));
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Durable Object returned ${response.status}`);
  return result as T;
}

async function readErrorBody(response: Response, maxBytes = 64 * 1024): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const slice = value.byteLength <= maxBytes - total ? value : value.slice(0, maxBytes - total);
    text += decoder.decode(slice, { stream: true });
    total += slice.byteLength;
    if (slice.byteLength < value.byteLength) break;
  }
  await reader.cancel("error body captured").catch(() => undefined);
  return truncate(text, 4000);
}

function usageEvent(
  base: Omit<UsageEvent, "usage" | "statusCode" | "latencyMs" | "createdAt">,
  usage: Usage,
  statusCode: number,
  latencyMs: number,
  firstTokenMs?: number,
): UsageEvent {
  return { ...base, usage, statusCode, latencyMs, firstTokenMs, createdAt: Math.floor(Date.now() / 1000) };
}

function queueError(env: Env, settings: LoggingSettings, event: UsageEvent): Promise<void> {
  if (!shouldPersistError(settings, event)) return Promise.resolve();
  return env.USAGE_QUEUE.send({ kind: "error", event });
}

function credentialCooldownMs(env: Env, credentialId: string, retryAfterMs?: number): number {
  if (isOpenCodeAnonymousCredential(credentialId)) return 0;
  return Math.max(asInt(env.CREDENTIAL_COOLDOWN_MS, 60_000), retryAfterMs ?? 0);
}

/**
 * Memoizes an async lookup for the lifetime of one request. A rejected entry is
 * evicted so a transient failure is retried on the next attempt.
 */
function requestMemo<T>(load: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (key: string): Promise<T> => {
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = load(key);
    pending.catch(() => {
      if (cache.get(key) === pending) cache.delete(key);
    });
    cache.set(key, pending);
    return pending;
  };
}

export async function proxyGeneration(
  c: Context<{ Bindings: Env }>,
  endpoint: GatewayEndpoint,
  preauthenticatedGatewayKey?: GatewayKeyRow,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  // Resolved inside the try so the settings read can overlap auth and body parsing;
  // the outer catch still needs a usable value if we fail before it lands.
  let logging: LoggingSettings = normalizeLoggingSettings({});
  let rateStub: DurableObjectStub | undefined;
  let rateLeaseId: string | undefined;
  let lastError: unknown;
  let logGatewayKeyId: string | undefined;
  let logPublicModel: string | undefined;
  let logProviderId: string | undefined;
  let logCredentialId: string | undefined;
  let logUpstreamModel: string | undefined;

  try {
    // External /v1 calls keep the existing Bearer-key path. The admin playground can pass
    // an already-selected key row after its own session guard has authenticated the operator.
    const rawKey = preauthenticatedGatewayKey ? "" : bearerToken(c.req.raw);
    const maxBody = asInt(c.env.MAX_BODY_BYTES, 8 * 1024 * 1024);
    // Logging settings, key authentication, and body parsing are mutually
    // independent; overlapping them removes two serial round trips from TTFB.
    // allSettled keeps the original failure precedence (auth before body) and
    // avoids an unhandled rejection when one of them loses the race.
    const [settled, authenticated, parsed] = await Promise.allSettled([
      getLoggingSettings(c.env),
      preauthenticatedGatewayKey
        ? Promise.resolve(preauthenticatedGatewayKey)
        : authenticateGatewayKey(c.env, rawKey),
      readJsonBody(c.req.raw, maxBody),
    ]);
    if (settled.status === "fulfilled") logging = settled.value;
    if (authenticated.status === "rejected") throw authenticated.reason;
    if (parsed.status === "rejected") throw parsed.reason;
    const gatewayKey = authenticated.value;
    const body = parsed.value;
    logGatewayKeyId = gatewayKey.id;
    const publicModel = typeof body.model === "string" ? body.model.trim() : "";
    logPublicModel = publicModel || undefined;
    if (!publicModel) throw new GatewayError(400, "INVALID_REQUEST", "The model field is required", "invalid_request_error");

    const allowedModels = parseJson<string[]>(gatewayKey.allowed_models_json, []);
    if (!await gatewayKeyAllowsModel(c.env, publicModel, allowedModels)) {
      throw new GatewayError(403, "MODEL_NOT_ALLOWED", `API key is not allowed to use model ${publicModel}`, "permission_error");
    }

    rateStub = c.env.RATE_LIMITER.get(c.env.RATE_LIMITER.idFromName(gatewayKey.id));
    const rateLease = await postDo<RateLease>(rateStub!, "/acquire", {
      rpm: gatewayKey.rpm,
      maxConcurrency: gatewayKey.max_concurrency,
      monthlyTokenLimit: gatewayKey.monthly_token_limit,
      estimatedTokens: estimateInputTokens(body),
    });
    if (!rateLease.allowed) {
      const status = rateLease.reason === "TOKEN_QUOTA_EXCEEDED" ? 402 : 429;
      const error = new GatewayError(status, rateLease.reason ?? "RATE_LIMIT_EXCEEDED", "Rate, concurrency, or token quota exceeded", "rate_limit_error");
      const response = errorResponse(error, requestId);
      if (rateLease.retryAfterMs) response.headers.set("retry-after", Math.max(1, Math.ceil(rateLease.retryAfterMs / 1000)).toString());
      const event = usageEvent({
        requestId,
        gatewayKeyId: gatewayKey.id,
        publicModel,
        endpoint,
        errorCode: error.code,
        errorMessage: error.message,
      }, { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 }, status, Date.now() - startedAt);
      c.executionCtx.waitUntil(queueError(c.env, logging, event).catch(() => undefined));
      runtimeLog(logging, "warn", { event: "gateway_rate_limited", request_id: requestId, status, code: error.code });
      return response;
    }
    rateLeaseId = rateLease.leaseId;

    let routes = await listRoutesForModel(c.env, publicModel, endpoint);
    if (routes.length === 0 && publicModel.startsWith("opencode/")) {
      await ensureOpenCodeAnonymousModels(c.env).catch(() => null);
      routes = await listRoutesForModel(c.env, publicModel, endpoint);
    }
    if (routes.length === 0) throw new GatewayError(404, "MODEL_NOT_FOUND", `No route is configured for model ${publicModel}`, "invalid_request_error");
    const ordered = await orderHealthyRoutes(c.env, routes);
    if (ordered.routes.length === 0) {
      const retryAt = ordered.blockedUntil ? Math.ceil(ordered.blockedUntil / 1000) : undefined;
      throw new GatewayError(503, "UPSTREAM_CIRCUIT_OPEN", retryAt
        ? `All upstream providers are temporarily unavailable; retry after ${new Date(retryAt * 1000).toISOString()}`
        : "All upstream providers are temporarily unavailable", "upstream_error");
    }

    // Each route gets two account attempts before falling through to the next route.
    const attemptPlan = ordered.routes.flatMap((route: ModelRouteRow) => [route, route]);
    const blockedProviders = new Set<string>();
    // Provider rows and route runtime options are static configuration for the
    // duration of one request, so the repeated attempt on the same route reuses
    // them instead of re-querying D1. Credential availability is deliberately NOT
    // memoized: it reflects live cooldown/quota state that the previous attempt
    // may have just changed.
    const providerFor = requestMemo<ProviderConfig>((providerId) => getProvider(c.env, providerId));
    const runtimeByRoute = new Map<string, Promise<RouteRuntimeOptions>>();
    const runtimeFor = (route: ModelRouteRow): Promise<RouteRuntimeOptions> => {
      // Route ids are unique per (provider, upstream model, endpoint) — including the
      // synthesized `discovered:*` ids — so they key the runtime options safely.
      const cached = runtimeByRoute.get(route.id);
      if (cached) return cached;
      const pending = routeRuntimeOptions(c.env, route, endpoint);
      pending.catch(() => {
        if (runtimeByRoute.get(route.id) === pending) runtimeByRoute.delete(route.id);
      });
      runtimeByRoute.set(route.id, pending);
      return pending;
    };
    let codexMultiAgentModels: ReturnType<typeof loadCodexMultiAgentModelProfiles> | undefined;

    for (const route of attemptPlan) {
      if (blockedProviders.has(route.provider_id)) continue;
      logProviderId = route.provider_id;
      logUpstreamModel = route.upstream_model;
      logCredentialId = undefined;
      let poolStub: DurableObjectStub | undefined;
      let poolLease: PoolLease | undefined;
      try {
        // getProvider returns a row whose id is the queried id, so the availability
        // lookup can key off route.provider_id and start without waiting for it.
        // All three D1 reads now overlap instead of running back to back.
        const providerPromise = providerFor(route.provider_id);
        const runtimePromise = runtimeFor(route);
        const availabilityPromise = listCredentialAvailabilityForModel(c.env, route.provider_id, route.upstream_model, endpoint);
        // Keep the original failure precedence: a config error must surface before
        // an availability error, and this also prevents an unhandled rejection.
        availabilityPromise.catch(() => undefined);
        const [provider, runtime] = await Promise.all([providerPromise, runtimePromise]);
        validateModelCapabilities(body, runtime.capabilities);
        const providerMultiAgentV2 = provider.options.codex_multi_agent_v2 === true || provider.options.codexMultiAgentV2 === true;
        const multiAgentEnabled = runtime.codexMultiAgentV2 ?? providerMultiAgentV2;
        const multiAgentEligible = multiAgentEnabled
          && endpoint === "responses"
          && isCodexMultiAgentClient(c.req.raw.headers.get("user-agent"));
        if (multiAgentEligible && !codexMultiAgentModels) {
          codexMultiAgentModels = loadCodexMultiAgentModelProfiles(c.env, allowedModels).catch(() => []);
        }
        const multiAgent = multiAgentEligible
          ? optimizeCodexMultiAgentV2Body(body, {
            enabled: true,
            endpoint,
            providerKind: provider.kind,
            userAgent: c.req.raw.headers.get("user-agent"),
            models: await codexMultiAgentModels!,
          })
          : { body, collaborationNamespaceOptimized: false };
        const routeBody = multiAgent.body;

        const availability = await availabilityPromise;
        const rows = availability.filter((entry: CredentialAvailability) => entry.available).map((entry: CredentialAvailability) => entry.row);
        if (rows.length === 0) {
          const blocked = availability.find((entry: CredentialAvailability) => !entry.available);
          const retry = blocked?.retryAt ? `，预计 ${new Date(blocked.retryAt * 1000).toISOString()} 恢复` : "";
          throw new GatewayError(503, "NO_CREDENTIAL_AVAILABLE", `${provider.name} 没有可用账号${blocked?.reason ? `：${blocked.reason}` : ""}${retry}`, "upstream_error");
        }
        const candidates: PoolCandidate[] = rows.map((row: CredentialRow) => ({
          id: row.id,
          priority: row.priority,
          weight: Math.max(1, row.weight),
          maxConcurrency: Math.max(1, row.max_concurrency),
          enabled: row.enabled === 1,
        }));
        poolStub = c.env.ACCOUNT_POOL.get(c.env.ACCOUNT_POOL.idFromName(provider.id));
        try {
          poolLease = await postDo<PoolLease>(poolStub!, "/acquire", {
            providerId: provider.id,
            strategy: provider.pool_strategy,
            candidates,
            model: publicModel,
            sessionKey: provider.options.session_affinity === false
              ? undefined
              : await buildSessionAffinityKey(c.req.raw, routeBody, gatewayKey.id, provider.id),
            leaseTtlMs: 15 * 60_000,
          });
        } catch (error) {
          throw new GatewayError(503, "NO_CREDENTIAL_AVAILABLE", error instanceof Error ? error.message : "No credential is currently available", "upstream_error");
        }

        let credential = await getCredential(c.env, poolLease.credentialId);
        logCredentialId = credential.id;
        if (credential.expires_at && credential.expires_at <= Math.floor(Date.now() / 1000) + 300 && credential.refreshToken) {
          const lock = await postDo<{ acquired: boolean; lockId?: string }>(poolStub!, "/lock", { credentialId: credential.id, ttlMs: 60_000 });
          if (lock.acquired && lock.lockId) {
            try {
              credential = await refreshCredentialForInference(c.env, provider, credential);
            } finally {
              await postDo(poolStub!, "/unlock", { credentialId: credential.id, lockId: lock.lockId }).catch(() => undefined);
            }
          } else if (credential.expires_at <= Math.floor(Date.now() / 1000)) {
            throw new GatewayError(503, "CREDENTIAL_REFRESH_BUSY", "Credential refresh is already in progress", "upstream_error");
          }
        }

        const upstreamRequest = await buildUpstreamRequest({
          requestId,
          endpoint,
          publicModel,
          upstreamModel: route.upstream_model,
          body: routeBody,
          originalRequest: c.req.raw,
          provider,
          credential,
        }, c.env);
        const timeoutMs = typeof provider.options.timeout_ms === "number" ? Math.max(1000, provider.options.timeout_ms) : 120_000;
        let upstream: Response;
        let mirrorCredentialFailure: ReturnType<typeof classifyUpstreamResponse> | undefined;
        try {
          if (provider.kind === "opencode") {
            const result = await fetchOpenCodeWithFailover({
              env: c.env,
              provider,
              credential,
              target: upstreamRequest.url,
              init: upstreamRequest.init,
              fetcher: (target, requestInit) => providerFetchForCredential(
                c.env, provider, credential, target, requestInit, { purpose: "inference", timeoutMs },
              ),
            });
            upstream = result.response;
            if (result.officialFailure && !isOpenCodeAnonymousCredential(credential.id)) {
              const classifiedOfficial = classifyUpstreamResponse(
                result.officialFailure.status,
                result.officialFailure.body,
                result.officialFailure.headers,
                provider.kind,
              );
              if (classifiedOfficial.code === "AUTH_UNAVAILABLE" || classifiedOfficial.code === "RATE_LIMIT_EXCEEDED") {
                mirrorCredentialFailure = classifiedOfficial;
                await setCredentialError(c.env, credential.id, `${classifiedOfficial.code}: ${classifiedOfficial.message}`).catch(() => undefined);
              }
            }
          } else {
            upstream = await providerFetchForCredential(c.env, provider, credential, upstreamRequest.url, upstreamRequest.init, { purpose: "inference", timeoutMs });
          }
        } catch (error) {
          const normalized = classifyTransportError(error, provider.name, timeoutMs);
          if (providerFailureEligible(normalized)) {
            const health = await recordProviderFailure(c.env, provider.id, normalized.status, normalized.message);
            if (health.disabledUntil > Date.now()) blockedProviders.add(provider.id);
          }
          throw normalized;
        }

        if (!upstream.ok) {
          c.executionCtx.waitUntil(captureQuotaHeaders(c.env, credential.id, provider.id, upstream.headers).catch(() => undefined));
          const detail = await readErrorBody(upstream);
          const classified = classifyUpstreamResponse(upstream.status, detail, upstream.headers, provider.kind);
          await postDo(poolStub!, "/release", {
            leaseId: poolLease.leaseId,
            success: false,
            statusCode: classified.status,
            cooldownMs: classified.credentialFailure ? credentialCooldownMs(c.env, credential.id, classified.retryAfterMs) : 0,
            cooldownEligible: classified.credentialFailure,
          }).catch(() => undefined);
          poolLease = undefined;
          if (classified.credentialFailure) await setCredentialError(c.env, credential.id, `${classified.code}: ${classified.message}`).catch(() => undefined);
          if (classified.providerFailure) {
            const health = await recordProviderFailure(c.env, provider.id, upstream.status, classified.message);
            if (health.disabledUntil > Date.now()) blockedProviders.add(provider.id);
          }
          if (isOpenCodeAnonymousCredential(credential.id)) blockedProviders.add(provider.id);
          const classifiedError = gatewayErrorFromClassification(classified);
          if (classified.retryable) {
            lastError = classifiedError;
            continue;
          }
          throw classifiedError;
        }

        c.executionCtx.waitUntil(captureQuotaHeaders(c.env, credential.id, provider.id, upstream.headers).catch(() => undefined));
        const downstream = await prepareProviderResponse({
          upstream,
          mode: upstreamRequest.responseMode,
          requestedStream: routeBody.stream === true,
          model: publicModel,
          requestId,
          providerKind: provider.kind,
          endpoint,
          forceResponseModelMapping: runtime.forceResponseModelMapping,
          restoreCodexCollaborationNamespace: multiAgent.collaborationNamespaceOptimized,
        });
        const eventBase = {
          requestId,
          gatewayKeyId: gatewayKey.id,
          providerId: provider.id,
          credentialId: credential.id,
          publicModel,
          upstreamModel: route.upstream_model,
          endpoint,
        };
        const leaseId = poolLease.leaseId;
        const tracked = trackResponse(downstream, startedAt, async ({ usage, firstTokenMs, streamError }) => {
          const finalStatus = streamError ? 502 : downstream.status;
          const streamCooldownEligible = streamError ? credentialCooldownEligible(streamError) : false;
          const event = {
            ...usageEvent(eventBase, usage, finalStatus, Date.now() - startedAt, firstTokenMs),
            ...(streamError ? { errorCode: "UPSTREAM_STREAM_ERROR", errorMessage: truncate(streamError, 1000) } : {}),
          };
          const tasks: Promise<unknown>[] = [
            postDo(poolStub!, "/release", {
              leaseId,
              success: !streamError && !mirrorCredentialFailure,
              statusCode: streamError ? finalStatus : mirrorCredentialFailure?.status ?? finalStatus,
              cooldownMs: streamError
                ? credentialCooldownMs(c.env, credential.id)
                : mirrorCredentialFailure
                  ? credentialCooldownMs(c.env, credential.id, mirrorCredentialFailure.retryAfterMs)
                  : 0,
              cooldownEligible: streamError ? streamCooldownEligible : mirrorCredentialFailure?.credentialFailure === true,
            }),
            postDo(rateStub!, "/release", {
              leaseId: rateLeaseId!,
              actualTokens: usage.totalTokens > 0 ? usage.totalTokens : undefined,
              ...(logging.requestLoggingEnabled ? { activity: event } : {}),
            }),
            queueError(c.env, logging, event),
            streamError
              ? Promise.allSettled([
                  ...(streamCooldownEligible ? [setCredentialError(c.env, credential.id, truncate(streamError, 1000))] : []),
                  ...(providerFailureEligible(streamError) ? [recordProviderFailure(c.env, provider.id, 502, streamError)] : []),
                ])
              : recordProviderSuccess(c.env, provider.id),
          ];
          rateLeaseId = undefined;
          runtimeLog(logging, streamError ? "error" : "debug", {
            event: streamError ? "gateway_stream_error" : "gateway_request_complete",
            request_id: requestId,
            provider_id: provider.id,
            credential_id: credential.id,
            status: finalStatus,
            latency_ms: event.latencyMs,
            total_tokens: usage.totalTokens,
          });
          c.executionCtx.waitUntil(Promise.allSettled(tasks).then(() => undefined));
        });
        tracked.headers.set("x-request-id", requestId);
        return tracked;
      } catch (error) {
        lastError = error;
        if (poolStub && poolLease) {
          await postDo(poolStub!, "/release", {
            leaseId: poolLease.leaseId,
            success: false,
            statusCode: error instanceof GatewayError ? error.status : 500,
            cooldownMs: credentialCooldownMs(c.env, poolLease.credentialId),
            cooldownEligible: credentialCooldownEligible(error),
          }).catch(() => undefined);
        }
        if (error instanceof GatewayError && error.status < 500 && error.code !== "AUTH_UNAVAILABLE" && error.code !== "RATE_LIMIT_EXCEEDED") throw error;
      }
    }

    throw lastError ?? new GatewayError(502, "UPSTREAM_UNAVAILABLE", "All upstream routes failed", "upstream_error");
  } catch (error) {
    const normalized = error instanceof GatewayError
      ? error
      : new GatewayError(500, "INTERNAL_ERROR", error instanceof Error ? error.message : "Internal gateway error");
    const event = usageEvent({
      requestId,
      gatewayKeyId: logGatewayKeyId,
      providerId: logProviderId,
      credentialId: logCredentialId,
      publicModel: logPublicModel,
      upstreamModel: logUpstreamModel,
      endpoint,
      errorCode: normalized.code,
      errorMessage: normalized.message,
    }, { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 }, normalized.status, Date.now() - startedAt);
    if (rateStub && rateLeaseId) {
      await postDo(rateStub, "/release", {
        leaseId: rateLeaseId,
        actualTokens: 0,
        ...(logging.requestLoggingEnabled ? { activity: event } : {}),
      }).catch(() => undefined);
      rateLeaseId = undefined;
    }
    c.executionCtx.waitUntil(queueError(c.env, logging, event).catch(() => undefined));
    runtimeLog(logging, normalized.status >= 500 ? "error" : "warn", {
      event: "gateway_error",
      request_id: requestId,
      status: normalized.status,
      code: normalized.code,
      error: normalized.message,
    });
    return errorResponse(normalized, requestId);
  }
}
