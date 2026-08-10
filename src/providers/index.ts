import { rememberCodexClientIdentity } from "../codex-client-identity";
import { applyReasoningSummaryIntent } from "../reasoning-summary-intent";
import type { Env, ProviderKind, ProxyRequestContext, UpstreamBuildResult } from "../types";
import { buildCodexCustomToolRequest } from "./codex-custom-tools";
import { buildGenericRequest } from "./generic";
import { buildKimiRequest } from "./kimi";
import { buildOpenCodeRequest } from "./opencode";
import { buildQoderRequest } from "./qoder";

export interface ProviderAdapter {
  build(context: ProxyRequestContext, env: Env): Promise<UpstreamBuildResult> | UpstreamBuildResult;
}

const adapters = new Map<ProviderKind, ProviderAdapter>([
  ["codex", { build: (context) => {
    rememberCodexClientIdentity(context.requestId, context.originalRequest);
    return buildCodexCustomToolRequest(context);
  } }],
  ["kimi", { build: (context) => buildKimiRequest(context) }],
  ["qoder", { build: (context, env) => buildQoderRequest(context, env) }],
  ["opencode", { build: (context) => buildOpenCodeRequest(context) }],
  ["openai-compatible", { build: (context) => buildGenericRequest(context) }],
  ["custom", { build: (context) => buildGenericRequest(context) }],
]);

const SUMMARY_INTENT_PROVIDER_KINDS = new Set<ProviderKind>(["codex", "kimi", "openai-compatible"]);

function applySummaryIntentToBuiltRequest(
  result: UpstreamBuildResult,
  context: ProxyRequestContext,
): UpstreamBuildResult {
  if (!SUMMARY_INTENT_PROVIDER_KINDS.has(context.provider.kind) || typeof result.init.body !== "string") return result;
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(result.init.body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return result;
    body = parsed as Record<string, unknown>;
  } catch {
    return result;
  }
  applyReasoningSummaryIntent(body, context);
  return { ...result, init: { ...result.init, body: JSON.stringify(body) } };
}

export function registerProviderAdapter(kind: ProviderKind, adapter: ProviderAdapter): void {
  adapters.set(kind, adapter);
}

export async function buildUpstreamRequest(context: ProxyRequestContext, env: Env): Promise<UpstreamBuildResult> {
  const adapter = adapters.get(context.provider.kind) ?? adapters.get("custom");
  if (!adapter) throw new Error(`No provider adapter registered for ${context.provider.kind}`);
  const result = await adapter.build(context, env);
  return applySummaryIntentToBuiltRequest(result, context);
}
