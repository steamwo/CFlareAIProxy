import type { Env, Usage, UsageAggregateEvent, UsageErrorEvent, UsageQueueEvent } from "./types";

interface PriceRow {
  provider_id: string;
  model: string;
  input_micros_per_million: number;
  output_micros_per_million: number;
  cache_micros_per_million: number;
}

function priceKey(providerId: string, model: string): string {
  return `${providerId}\u0000${model}`;
}

function costMicros(usage: Usage, price?: PriceRow): number {
  if (!price) return 0;
  const cachedTokens = Math.min(usage.promptTokens, usage.cachedTokens);
  const uncachedInputTokens = Math.max(0, usage.promptTokens - cachedTokens);
  return Math.max(0, Math.ceil(
    (uncachedInputTokens * price.input_micros_per_million
      + cachedTokens * price.cache_micros_per_million
      + usage.completionTokens * price.output_micros_per_million) / 1_000_000,
  ));
}

function aggregateStatement(env: Env, event: UsageAggregateEvent, price?: PriceRow): D1PreparedStatement {
  const cost = costMicros({
    promptTokens: event.promptTokens,
    completionTokens: event.completionTokens,
    cachedTokens: event.cachedTokens,
    totalTokens: event.totalTokens,
  }, price);
  return env.DB.prepare(
    `INSERT INTO request_activity_5m
      (bucket,source_id,gateway_key_id,provider_id,credential_id,public_model,upstream_model,endpoint,
       requests,successes,failures,prompt_tokens,completion_tokens,cached_tokens,total_tokens,cost_micros,
       latency_sum_ms,first_token_sum_ms,first_token_samples,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(bucket,source_id,provider_id,credential_id,public_model,upstream_model,endpoint) DO UPDATE SET
       gateway_key_id=excluded.gateway_key_id,
       requests=MAX(request_activity_5m.requests,excluded.requests),
       successes=MAX(request_activity_5m.successes,excluded.successes),
       failures=MAX(request_activity_5m.failures,excluded.failures),
       prompt_tokens=MAX(request_activity_5m.prompt_tokens,excluded.prompt_tokens),
       completion_tokens=MAX(request_activity_5m.completion_tokens,excluded.completion_tokens),
       cached_tokens=MAX(request_activity_5m.cached_tokens,excluded.cached_tokens),
       total_tokens=MAX(request_activity_5m.total_tokens,excluded.total_tokens),
       cost_micros=MAX(request_activity_5m.cost_micros,excluded.cost_micros),
       latency_sum_ms=MAX(request_activity_5m.latency_sum_ms,excluded.latency_sum_ms),
       first_token_sum_ms=MAX(request_activity_5m.first_token_sum_ms,excluded.first_token_sum_ms),
       first_token_samples=MAX(request_activity_5m.first_token_samples,excluded.first_token_samples),
       updated_at=MAX(request_activity_5m.updated_at,excluded.updated_at)`,
  ).bind(
    event.bucket,
    event.sourceId,
    event.gatewayKeyId,
    event.providerId,
    event.credentialId,
    event.publicModel,
    event.upstreamModel,
    event.endpoint,
    event.requests,
    event.successes,
    event.failures,
    event.promptTokens,
    event.completionTokens,
    event.cachedTokens,
    event.totalTokens,
    cost,
    event.latencySumMs,
    event.firstTokenSumMs,
    event.firstTokenSamples,
    event.updatedAt,
  );
}

function errorStatement(env: Env, message: UsageErrorEvent, price?: PriceRow): D1PreparedStatement {
  const event = message.event;
  const cost = costMicros(event.usage, price);
  return env.DB.prepare(
    `INSERT OR REPLACE INTO request_logs
      (request_id,gateway_key_id,provider_id,credential_id,public_model,upstream_model,
       endpoint,status_code,prompt_tokens,completion_tokens,cached_tokens,total_tokens,cost_micros,latency_ms,
       first_token_ms,error_code,error_message,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    event.requestId,
    event.gatewayKeyId ?? null,
    event.providerId ?? null,
    event.credentialId ?? null,
    event.publicModel ?? null,
    event.upstreamModel ?? null,
    event.endpoint ?? null,
    event.statusCode,
    event.usage.promptTokens,
    event.usage.completionTokens,
    event.usage.cachedTokens,
    event.usage.totalTokens,
    cost,
    event.latencyMs,
    event.firstTokenMs ?? null,
    event.errorCode ?? null,
    event.errorMessage?.slice(0, 1000) ?? null,
    event.createdAt,
  );
}

export async function persistUsageQueueBatch(env: Env, events: UsageQueueEvent[]): Promise<void> {
  if (!events.length) return;
  const prices = await env.DB.prepare(
    "SELECT provider_id,model,input_micros_per_million,output_micros_per_million,cache_micros_per_million FROM model_prices",
  ).all<PriceRow>();
  const priceMap = new Map(prices.results.map((row) => [priceKey(row.provider_id, row.model), row] as const));
  const statements = events.map((message) => {
    if (message.kind === "aggregate") {
      return aggregateStatement(env, message, priceMap.get(priceKey(message.providerId, message.upstreamModel)));
    }
    const event = message.event;
    return errorStatement(env, message, event.providerId && event.upstreamModel
      ? priceMap.get(priceKey(event.providerId, event.upstreamModel))
      : undefined);
  });
  for (let index = 0; index < statements.length; index += 50) {
    await env.DB.batch(statements.slice(index, index + 50));
  }
}
