import { rememberCodexClientIdentity } from "../codex-client-identity";
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

export function registerProviderAdapter(kind: ProviderKind, adapter: ProviderAdapter): void {
  adapters.set(kind, adapter);
}

export async function buildUpstreamRequest(context: ProxyRequestContext, env: Env): Promise<UpstreamBuildResult> {
  const adapter = adapters.get(context.provider.kind) ?? adapters.get("custom");
  if (!adapter) throw new Error(`No provider adapter registered for ${context.provider.kind}`);
  return adapter.build(context, env);
}
