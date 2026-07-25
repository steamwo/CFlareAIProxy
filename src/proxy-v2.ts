import type { Context } from "hono";
import {
  isCodexMultiAgentClient, loadCodexMultiAgentModelProfiles, optimizeCodexMultiAgentV2Body,
} from "./codex-multi-agent-v2";
import { providerFetchForCredential } from "./credential-fetch";
import { authenticateGatewayKey, getCredential, getProvider, listCredentialAvailabilityForModel, listRoutesForModel, setCredentialError } from "./db";
import type { CredentialAvailability } from "./db";
import { GatewayError, errorResponse } from "./errors";
import { getLoggingSettings, runtimeLog, shouldPersistError } from "./logging-settings";
import { routeRuntimeOptions, validateModelCapabilities } from "./model-capabilities";
import { ensureOpenCodeAnonymousModels } from "./models";
import { refreshCredentialForInference } from "./credential-refresh";
import { prepareProviderResponse } from "./provider-response";
import { buildUpstreamRequest } from "./providers";
import { fetchOpenCodeWithFailover } from "./providers/opencode-failover";
import { isOpenCodeAnonymousCredential } from "./providers/opencode-anonymous";
import { captureQuotaHeaders } from "./quota";
import { orderHealthyRoutes, recordProviderFailure, recordProviderSuccess } from "./routing-health";
import { trackResponse } from "./stream";
import type { CredentialRow, Env, GatewayEndpoint, LoggingSettings, ModelRouteRow, PoolCandidate, PoolLease, RateLease, Usage, UsageEvent } from "./types";
import { classifyTransportError, classifyUpstreamResponse, gatewayErrorFromClassification } from "./upstream-errors";
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

function sessionKey(request: Request, body: Record<string, unknown>, gatewayKeyId: string, providerId: string): string | undefined {
  const explicit = request.headers.get("x-session-id") ?? request.headers.get("x-conversation-id");
  const user = typeof body.user === "string" ? body.user : undefined;
  const previous = typeof body.previous_response_id === "string" ? body.previous_response_id : undefined;
  const value = explicit ?? previous ?? user;
  return value ? `${providerId}:${gatewayKeyId}:${value}` : undefined;
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

export async function proxyGeneration(c: Context<{ Bindings: Env }>, endpoint: GatewayEndpoint): Promise<Response> {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const logging = await getLoggingSettings(c.env);
  let rateStub: DurableObjectStub | undefined;
  let rateLeaseId: string | undefined;
  let lastError: unknown;
  let logGatewayKeyId: string | undefined;
  let logPublicModel: string | undefined;
  let logProviderId: string | undefined;
  let logCredentialId: string | undefined;
  let logUpstreamModel: string | undefined;

  try {
    const rawKey = bearerToken(c.req.raw);
    const gatewayKey = await authenticateGatewayKey(c.env, rawKey);
    logGatewayKeyId = gatewayKey.id;
    const maxBody = asInt(c.env.MAX_BODY_BYTES, 8 * 1024 * 1024);
    const body = await readJsonBody(c.req.raw, maxBody);
    const publicModel = typeof body.model === "string" ? body.model.trim() : "";
    logPublicModel = publicModel || undefined;
    if (!publicModel) throw new GatewayError(400, "INVALID_REQUEST", "The model field is required", "invalid_request_error");

    const allowedModels = parseJson<string[]>(gatewayKey.allowed_models_json, []);
    if (allowedModels.length > 0 && !allowedModels.includes(publicModel)) {
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
    let codexMultiAgentModels: ReturnType<typeof loadCodexMultiAgentModelProfiles> | undefined;

    for (const route of attemptPlan) {
      if (blockedProviders.has(route.provider_id)) continue;
      logProviderId = route.provider_id;
      logUpstreamModel = route.upstream_model;
      logCredentialId = undefined;
      let poolStub: DurableObjectStub | undefined;
      let poolLease: PoolLease | undefined;
      try {
        const provider = await getProvider(c.env, route.provider_id);
        const runtime = await routeRuntimeOptions(c.env, route, endpoint);
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

        const availability = await listCredentialAvailabilityForModel(c.env, provider.id, route.upstream_model, endpoint);
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
            sessionKey: provider.options.session_affinity === false ? undefined : sessionKey(c.req.raw, routeBody, gatewayKey.id, provider.id),
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
          const health = await recordProviderFailure(c.env, provider.id, normalized.status, normalized.message);
          if (health.disabledUntil > Date.now()) blockedProviders.add(provider.id);
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
            }),
            postDo(rateStub!, "/release", {
              leaseId: rateLeaseId!,
              actualTokens: usage.totalTokens > 0 ? usage.totalTokens : undefined,
              ...(logging.requestLoggingEnabled ? { activity: event } : {}),
            }),
            queueError(c.env, logging, event),
            streamError
              ? Promise.allSettled([
                  setCredentialError(c.env, credential.id, truncate(streamError, 1000)),
                  recordProviderFailure(c.env, provider.id, 502, streamError),
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
