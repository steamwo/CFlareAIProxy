import { GatewayError } from "./errors";
import {
  markOpenAiTextOnlyToolResultNormalization,
  prepareOpenAiToolResultsForValidation,
} from "./openai-tool-results";
import type { Env, GatewayEndpoint, ModelRouteRow } from "./types";
import { parseJson } from "./utils";

export const SUPPORTED_REASONING_LEVELS = new Set([
  "none", "auto", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
]);

export interface ModelCapabilities {
  inputModalities?: string[];
  outputModalities?: string[];
  reasoningLevels?: string[];
  serviceTiers?: string[];
  contextWindow?: number;
  visibility?: "list" | "hide";
  priority?: number;
  supportsTools?: boolean;
  supportsImages?: boolean;
  supportsSearchTool?: boolean;
  forceResponseModelMapping?: boolean;
}

export interface RouteRuntimeOptions {
  capabilities: ModelCapabilities;
  forceResponseModelMapping: boolean;
  codexMultiAgentV2?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown, objectKey?: string): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output = value.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim()) return [entry.trim().toLowerCase()];
    if (!objectKey) return [];
    const object = record(entry);
    const nested = object[objectKey];
    return typeof nested === "string" && nested.trim() ? [nested.trim().toLowerCase()] : [];
  });
  return output.length ? [...new Set(output)] : undefined;
}

function reasoningLevels(value: unknown): string[] | undefined {
  const normalized = strings(value, "effort")?.filter((level) => SUPPORTED_REASONING_LEVELS.has(level));
  return normalized?.length ? normalized : undefined;
}

function positiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return undefined;
}

function booleanValue(...values: unknown[]): boolean | undefined {
  for (const value of values) if (typeof value === "boolean") return value;
  return undefined;
}

export function normalizeCapabilities(value: unknown): ModelCapabilities {
  const raw = record(value);
  const rawVisibility = typeof raw.visibility === "string" ? raw.visibility.trim().toLowerCase() : "";
  return {
    inputModalities: strings(raw.inputModalities ?? raw.input_modalities ?? raw.supported_input_modalities),
    outputModalities: strings(raw.outputModalities ?? raw.output_modalities ?? raw.supported_output_modalities),
    // Unknown levels are deliberately removed. If a configured declaration contains no
    // valid levels, merge precedence falls back to the next capability source.
    reasoningLevels: reasoningLevels(raw.reasoningLevels ?? raw.reasoning_levels ?? raw.supported_reasoning_levels),
    serviceTiers: strings(raw.serviceTiers ?? raw.service_tiers, "id"),
    // max-context-length is the explicit configured override used by upstream. Keep it
    // ahead of discovered/default aliases within one source, while source precedence
    // remains route > provider > discovery in the merge below.
    contextWindow: positiveNumber(
      raw.maxContextLength,
      raw.max_context_length,
      raw["max-context-length"],
      raw.contextWindow,
      raw.context_window,
      raw.context_length,
      raw.max_context_window,
    ),
    visibility: rawVisibility === "hide" || rawVisibility === "list" ? rawVisibility : undefined,
    priority: positiveNumber(raw.priority),
    supportsTools: booleanValue(raw.supportsTools, raw.supports_tools),
    supportsImages: booleanValue(raw.supportsImages, raw.supports_images),
    supportsSearchTool: booleanValue(raw.supportsSearchTool, raw.supports_search_tool),
    forceResponseModelMapping: raw.forceResponseModelMapping === true || raw.force_response_model_mapping === true ? true : undefined,
  };
}

export function mergeModelCapabilities(primary: ModelCapabilities, fallback: ModelCapabilities): ModelCapabilities {
  return {
    inputModalities: primary.inputModalities ?? fallback.inputModalities,
    outputModalities: primary.outputModalities ?? fallback.outputModalities,
    reasoningLevels: primary.reasoningLevels ?? fallback.reasoningLevels,
    serviceTiers: primary.serviceTiers ?? fallback.serviceTiers,
    contextWindow: primary.contextWindow ?? fallback.contextWindow,
    visibility: primary.visibility ?? fallback.visibility,
    priority: primary.priority ?? fallback.priority,
    supportsTools: primary.supportsTools ?? fallback.supportsTools,
    supportsImages: primary.supportsImages ?? fallback.supportsImages,
    supportsSearchTool: primary.supportsSearchTool ?? fallback.supportsSearchTool,
    forceResponseModelMapping: primary.forceResponseModelMapping ?? fallback.forceResponseModelMapping,
  };
}

function modelIdentifier(value: Record<string, unknown>): string {
  for (const key of ["id", "model", "model_id", "modelId", "name"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function configuredModelDefinition(options: Record<string, unknown>, modelId: string): unknown {
  for (const value of [options.model_capabilities, options.modelCapabilities]) {
    const map = record(value);
    if (Object.prototype.hasOwnProperty.call(map, modelId)) return map[modelId];
  }

  for (const value of [options.models, options.configured_models, options.configuredModels]) {
    if (Array.isArray(value)) {
      const match = value.find((entry) => modelIdentifier(record(entry)) === modelId);
      if (match !== undefined) return match;
      continue;
    }
    const map = record(value);
    if (Object.prototype.hasOwnProperty.call(map, modelId)) return map[modelId];
  }
  return undefined;
}

export function configuredModelCapabilities(options: Record<string, unknown>, modelId: string): ModelCapabilities {
  const definition = record(configuredModelDefinition(options, modelId));
  if (!Object.keys(definition).length) return {};
  return normalizeCapabilities(
    definition.capabilities
      ?? definition.model_capabilities
      ?? definition.modelCapabilities
      ?? definition,
  );
}

function discoveredCapabilities(capabilitiesJson: string | undefined, rawJson: string | undefined): ModelCapabilities {
  const raw = rawJson ? normalizeCapabilities(parseJson(rawJson, {})) : {};
  const explicit = capabilitiesJson ? normalizeCapabilities(parseJson(capabilitiesJson, {})) : {};
  return mergeModelCapabilities(explicit, raw);
}

export async function routeRuntimeOptions(env: Env, route: ModelRouteRow, endpoint: GatewayEndpoint): Promise<RouteRuntimeOptions> {
  const options = parseJson<Record<string, unknown>>(route.options_json, {});
  const row = await env.DB.prepare(
    `SELECT p.kind AS provider_kind,p.options_json AS provider_options_json,d.capabilities_json,d.raw_json
     FROM providers p
     LEFT JOIN discovered_models d
       ON d.provider_id=p.id AND d.model_id=? AND d.endpoint=? AND d.enabled=1
     WHERE p.id=?
     ORDER BY d.discovered_at DESC,d.credential_id ASC LIMIT 1`,
  ).bind(route.upstream_model, endpoint, route.provider_id).first<{
    provider_kind: string;
    provider_options_json: string;
    capabilities_json: string | null;
    raw_json: string | null;
  }>().catch(() => null);
  const discovered = row
    ? discoveredCapabilities(row.capabilities_json ?? undefined, row.raw_json ?? undefined)
    : {};
  const providerOptions = row ? parseJson<Record<string, unknown>>(row.provider_options_json, {}) : {};
  const providerConfigured = configuredModelCapabilities(providerOptions, route.upstream_model);
  const routeConfigured = normalizeCapabilities(options.capabilities ?? options.model_capabilities);
  const capabilities = mergeModelCapabilities(
    routeConfigured,
    mergeModelCapabilities(providerConfigured, discovered),
  );
  if (row?.provider_kind === "openai-compatible") markOpenAiTextOnlyToolResultNormalization(capabilities);
  const forceResponseModelMapping = options.force_response_model_mapping === true
    || options.forceResponseModelMapping === true
    || capabilities.forceResponseModelMapping === true;
  const routeMultiAgentFlag = options.codex_multi_agent_v2 ?? options.codexMultiAgentV2;
  const codexMultiAgentV2 = typeof routeMultiAgentFlag === "boolean" ? routeMultiAgentFlag : undefined;
  return { capabilities, forceResponseModelMapping, codexMultiAgentV2 };
}

function containsImage(value: unknown, depth = 0): boolean {
  if (depth > 8 || value == null) return false;
  if (Array.isArray(value)) return value.some((entry) => containsImage(entry, depth + 1));
  if (typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const type = typeof row.type === "string" ? row.type.toLowerCase() : "";
  if (type === "image_url" || type === "input_image" || type === "image") return true;
  return Object.values(row).some((entry) => containsImage(entry, depth + 1));
}

export function validateModelCapabilities(body: Record<string, unknown>, capabilities: ModelCapabilities): void {
  prepareOpenAiToolResultsForValidation(body, capabilities);
  if (capabilities.supportsTools === false && Array.isArray(body.tools) && body.tools.length > 0) {
    throw new GatewayError(400, "MODEL_TOOLS_UNSUPPORTED", "The selected model does not support tool calls", "invalid_request_error");
  }
  const imageAllowed = capabilities.supportsImages !== false
    && (!capabilities.inputModalities || capabilities.inputModalities.includes("image"));
  if (!imageAllowed && containsImage(body)) {
    throw new GatewayError(400, "MODEL_IMAGE_INPUT_UNSUPPORTED", "The selected model does not support image input", "invalid_request_error");
  }
  const reasoning = record(body.reasoning);
  const effort = typeof reasoning.effort === "string" ? reasoning.effort.toLowerCase() : typeof body.reasoning_effort === "string" ? body.reasoning_effort.toLowerCase() : undefined;
  if (effort && capabilities.reasoningLevels && !capabilities.reasoningLevels.includes(effort)) {
    throw new GatewayError(400, "MODEL_REASONING_LEVEL_UNSUPPORTED", `The selected model does not support reasoning level ${effort}`, "invalid_request_error");
  }
}

export async function enrichModelsWithCapabilities(env: Env, models: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  const [discoveredResult, routeResult, providerResult] = await Promise.all([
    env.DB.prepare(
      `SELECT provider_id,model_id,capabilities_json,raw_json,discovered_at
       FROM (
         SELECT provider_id,model_id,capabilities_json,raw_json,discovered_at,
                ROW_NUMBER() OVER (
                  PARTITION BY provider_id,model_id
                  ORDER BY discovered_at DESC,credential_id ASC
                ) AS row_number
         FROM discovered_models WHERE enabled=1
       )
       WHERE row_number=1`,
    ).all<{ provider_id: string; model_id: string; capabilities_json: string; raw_json: string; discovered_at: number }>().catch(() => ({ results: [] })),
    env.DB.prepare(
      `SELECT public_model,provider_id,upstream_model,options_json
       FROM model_routes WHERE enabled=1 ORDER BY priority ASC,created_at ASC`,
    ).all<{ public_model: string; provider_id: string; upstream_model: string; options_json: string }>().catch(() => ({ results: [] })),
    env.DB.prepare("SELECT id,options_json FROM providers WHERE enabled=1")
      .all<{ id: string; options_json: string }>().catch(() => ({ results: [] })),
  ]);
  const providerOptions = new Map(providerResult.results.map((row) => [
    row.id,
    parseJson<Record<string, unknown>>(row.options_json, {}),
  ] as const));
  const discovered = new Map<string, ModelCapabilities>(discoveredResult.results.map((row) => {
    const configured = configuredModelCapabilities(providerOptions.get(row.provider_id) ?? {}, row.model_id);
    const live = discoveredCapabilities(row.capabilities_json, row.raw_json);
    return [`${row.provider_id}/${row.model_id}`, mergeModelCapabilities(configured, live)] as const;
  }));
  const routed = new Map<string, ModelCapabilities>();
  for (const route of routeResult.results) {
    if (routed.has(route.public_model)) continue;
    const options = parseJson<Record<string, unknown>>(route.options_json, {});
    const routeConfigured = normalizeCapabilities(options.capabilities ?? options.model_capabilities);
    const providerConfigured = configuredModelCapabilities(providerOptions.get(route.provider_id) ?? {}, route.upstream_model);
    const live = discovered.get(`${route.provider_id}/${route.upstream_model}`) ?? {};
    routed.set(
      route.public_model,
      mergeModelCapabilities(routeConfigured, mergeModelCapabilities(providerConfigured, live)),
    );
  }
  return models.map((model) => {
    const directKey = typeof model.x_cflare_provider === "string" && typeof model.x_cflare_upstream_model === "string"
      ? `${model.x_cflare_provider}/${model.x_cflare_upstream_model}`
      : "";
    const publicModel = typeof model.id === "string" ? model.id : "";
    const capabilities = (directKey ? discovered.get(directKey) : undefined) ?? routed.get(publicModel);
    return capabilities && Object.values(capabilities).some((entry) => entry !== undefined)
      ? { ...model, x_cflare_capabilities: capabilities }
      : model;
  });
}
