import { extractSessionAffinitySignals } from "../session-affinity";
import type { ProviderConfig, ProxyRequestContext } from "../types";

const MAX_PROMPT_CACHE_KEY_LENGTH = 256;
const CONTROL_CHARACTER = /\p{Cc}/u;
const DERIVED_PROMPT_CACHE_NAMESPACE = "cflareai:openai-compat:prompt-cache:v1";
const routeSupportByBody = new WeakMap<Record<string, unknown>, boolean>();

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function booleanOption(value: Record<string, unknown>): boolean | undefined {
  for (const key of [
    "support-prompt-cache-key",
    "support_prompt_cache_key",
    "supportPromptCacheKey",
    "supports-prompt-cache-key",
    "supports_prompt_cache_key",
    "supportsPromptCacheKey",
  ]) {
    if (typeof value[key] === "boolean") return value[key] as boolean;
  }
  return undefined;
}

function modelIdentifier(value: Record<string, unknown>): string {
  for (const key of ["id", "model", "model_id", "modelId", "name"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function configuredModelDefinition(options: Record<string, unknown>, modelId: string): Record<string, unknown> {
  for (const value of [options.model_capabilities, options.modelCapabilities]) {
    const map = record(value);
    if (Object.prototype.hasOwnProperty.call(map, modelId)) return record(map[modelId]);
  }

  for (const value of [options.models, options.configured_models, options.configuredModels]) {
    if (Array.isArray(value)) {
      const match = value.find((entry) => modelIdentifier(record(entry)) === modelId);
      if (match !== undefined) return record(match);
      continue;
    }
    const map = record(value);
    if (Object.prototype.hasOwnProperty.call(map, modelId)) return record(map[modelId]);
  }
  return {};
}

function configuredModelPromptCacheSupport(options: Record<string, unknown>, modelId: string): boolean | undefined {
  const definition = configuredModelDefinition(options, modelId);
  if (!Object.keys(definition).length) return undefined;
  const capabilities = record(
    definition.capabilities
      ?? definition.model_capabilities
      ?? definition.modelCapabilities
      ?? definition,
  );
  return booleanOption(capabilities);
}

export function setOpenAiPromptCacheRouteSupport(body: Record<string, unknown>, support: boolean | undefined): void {
  routeSupportByBody.delete(body);
  if (support !== undefined) routeSupportByBody.set(body, support);
}

export function supportsOpenAiPromptCacheKey(
  provider: ProviderConfig,
  modelId: string,
  body?: Record<string, unknown>,
): boolean {
  if (provider.kind !== "openai-compatible") return false;
  const routeSupport = body ? routeSupportByBody.get(body) : undefined;
  if (routeSupport !== undefined) return routeSupport;
  const modelSupport = configuredModelPromptCacheSupport(provider.options, modelId);
  if (modelSupport !== undefined) return modelSupport;
  return booleanOption(provider.options) ?? false;
}

function explicitPromptCacheKey(value: unknown): string | undefined {
  if (typeof value !== "string" || CONTROL_CHARACTER.test(value)) return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_PROMPT_CACHE_KEY_LENGTH ? normalized : undefined;
}

function uuidFromDigest(digest: ArrayBuffer): string {
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function derivedPromptCacheKey(context: ProxyRequestContext): Promise<string | undefined> {
  const signal = extractSessionAffinitySignals(context.originalRequest, context.body)
    .find((entry) => entry.source !== "client-request" && entry.source !== "prompt-cache");
  if (!signal) return undefined;

  const gatewayScope = context.originalRequest.headers.get("authorization")?.trim();
  if (!gatewayScope) return undefined;

  const seed = [
    DERIVED_PROMPT_CACHE_NAMESPACE,
    context.provider.id,
    context.credential.id,
    context.publicModel,
    context.upstreamModel,
    context.endpoint,
    gatewayScope,
    signal.source,
    signal.value,
  ].join("\0");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  return uuidFromDigest(digest);
}

export async function applyOpenAiPromptCacheKey(
  body: Record<string, unknown>,
  context: ProxyRequestContext,
): Promise<void> {
  if (!supportsOpenAiPromptCacheKey(context.provider, context.upstreamModel, context.body)) {
    delete body.prompt_cache_key;
    return;
  }

  const callerKey = explicitPromptCacheKey(context.body.prompt_cache_key);
  if (callerKey) {
    body.prompt_cache_key = callerKey;
    return;
  }

  const configuredKey = explicitPromptCacheKey(body.prompt_cache_key);
  if (configuredKey) {
    body.prompt_cache_key = configuredKey;
    return;
  }

  const derived = await derivedPromptCacheKey(context);
  if (derived) body.prompt_cache_key = derived;
  else delete body.prompt_cache_key;
}
