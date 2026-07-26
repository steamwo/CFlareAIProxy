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

const ACTIVITY_COLUMNS = `bucket,source_id,gateway_key_id,provider_id,credential_id,public_model,upstream_model,endpoint,
       requests,successes,failures,prompt_tokens,completion_tokens,cached_tokens,total_tokens,cost_micros,
       latency_sum_ms,first_token_sum_ms,first_token_samples,updated_at`;

const ACTIVITY_CONFLICT_TARGET = "bucket,source_id,provider_id,credential_id,public_model,upstream_model,endpoint";

/**
 * Delta merge, used for events carrying a flushId. The Durable Object drops its local
 * counters after every flush and restarts a bucket from zero, so a later flush of the same
 * bucket carries only the requests seen since the previous flush and must be added, not
 * MAX()-merged (which silently discarded the smaller follow-up value).
 *
 * The `WHERE NOT EXISTS` guard plus the companion usage_flush_dedupe insert make redelivery
 * (queue max_retries=3) a no-op: both statements land in the same D1 batch transaction, so a
 * flush id is only recorded when its delta was actually applied.
 */
const ACTIVITY_DELTA_SQL = `INSERT INTO request_activity_5m (${ACTIVITY_COLUMNS})
     SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
     WHERE NOT EXISTS (SELECT 1 FROM usage_flush_dedupe WHERE flush_id=?)
     ON CONFLICT(${ACTIVITY_CONFLICT_TARGET}) DO UPDATE SET
       gateway_key_id=excluded.gateway_key_id,
       requests=request_activity_5m.requests+excluded.requests,
       successes=request_activity_5m.successes+excluded.successes,
       failures=request_activity_5m.failures+excluded.failures,
       prompt_tokens=request_activity_5m.prompt_tokens+excluded.prompt_tokens,
       completion_tokens=request_activity_5m.completion_tokens+excluded.completion_tokens,
       cached_tokens=request_activity_5m.cached_tokens+excluded.cached_tokens,
       total_tokens=request_activity_5m.total_tokens+excluded.total_tokens,
       cost_micros=request_activity_5m.cost_micros+excluded.cost_micros,
       latency_sum_ms=request_activity_5m.latency_sum_ms+excluded.latency_sum_ms,
       first_token_sum_ms=request_activity_5m.first_token_sum_ms+excluded.first_token_sum_ms,
       first_token_samples=request_activity_5m.first_token_samples+excluded.first_token_samples,
       updated_at=MAX(request_activity_5m.updated_at,excluded.updated_at)`;

/** Legacy cumulative merge, kept for messages enqueued before flushId existed. */
const ACTIVITY_CUMULATIVE_SQL = `INSERT INTO request_activity_5m (${ACTIVITY_COLUMNS})
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(${ACTIVITY_CONFLICT_TARGET}) DO UPDATE SET
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
       updated_at=MAX(request_activity_5m.updated_at,excluded.updated_at)`;

/** Retention for flush ids; far beyond the queue retry + DLQ window. */
const FLUSH_DEDUPE_TTL_SECONDS = 24 * 60 * 60;
const FLUSH_DEDUPE_PRUNE_LIMIT = 500;
/** D1 writes are the expensive op here, so prune on a sample of batches rather than every one. */
const FLUSH_DEDUPE_PRUNE_EVERY = 50;
let flushDedupeBatchCounter = 0;

function aggregateStatements(env: Env, event: UsageAggregateEvent, price?: PriceRow): D1PreparedStatement[] {
  const cost = costMicros({
    promptTokens: event.promptTokens,
    completionTokens: event.completionTokens,
    cachedTokens: event.cachedTokens,
    totalTokens: event.totalTokens,
  }, price);
  const values = [
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
  ];
  const flushId = event.flushId;
  if (!flushId) return [env.DB.prepare(ACTIVITY_CUMULATIVE_SQL).bind(...values)];
  return [
    env.DB.prepare(ACTIVITY_DELTA_SQL).bind(...values, flushId),
    env.DB.prepare("INSERT INTO usage_flush_dedupe(flush_id,created_at) VALUES(?,?) ON CONFLICT(flush_id) DO NOTHING")
      .bind(flushId, event.updatedAt),
  ];
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
  // Each group is an atomic unit: a delta insert and its dedupe marker must land in the same
  // D1 batch (one transaction), otherwise a retry could re-apply a delta whose marker was lost.
  const groups = events.map((message) => {
    if (message.kind === "aggregate") {
      return aggregateStatements(env, message, priceMap.get(priceKey(message.providerId, message.upstreamModel)));
    }
    const event = message.event;
    return [errorStatement(env, message, event.providerId && event.upstreamModel
      ? priceMap.get(priceKey(event.providerId, event.upstreamModel))
      : undefined)];
  });

  let chunk: D1PreparedStatement[] = [];
  for (const group of groups) {
    if (chunk.length > 0 && chunk.length + group.length > 50) {
      await env.DB.batch(chunk);
      chunk = [];
    }
    chunk.push(...group);
  }
  if (chunk.length > 0) await env.DB.batch(chunk);

  await pruneFlushDedupe(env);
}

async function pruneFlushDedupe(env: Env): Promise<void> {
  flushDedupeBatchCounter = (flushDedupeBatchCounter + 1) % FLUSH_DEDUPE_PRUNE_EVERY;
  if (flushDedupeBatchCounter !== 0) return;
  const cutoff = Math.floor(Date.now() / 1000) - FLUSH_DEDUPE_TTL_SECONDS;
  try {
    await env.DB.prepare(
      `DELETE FROM usage_flush_dedupe WHERE flush_id IN
        (SELECT flush_id FROM usage_flush_dedupe WHERE created_at < ? LIMIT ?)`,
    ).bind(cutoff, FLUSH_DEDUPE_PRUNE_LIMIT).run();
  } catch (error) {
    // Pruning is best effort: it must never fail an otherwise successful usage batch,
    // which the queue would then redeliver.
    console.error(JSON.stringify({
      event: "usage_flush_dedupe_prune_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}
