import { GatewayError } from "./errors";
import type { Env, GatewayEndpoint, ModelRouteRow } from "./types";
import { parseJson } from "./utils";

export interface ModelCapabilities {
  inputModalities?: string[];
  outputModalities?: string[];
  reasoningLevels?: string[];
  supportsTools?: boolean;
  supportsImages?: boolean;
  forceResponseModelMapping?: boolean;
}

export interface RouteRuntimeOptions {
  capabilities: ModelCapabilities;
  forceResponseModelMapping: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim().toLowerCase());
  return output.length ? [...new Set(output)] : undefined;
}

export function normalizeCapabilities(value: unknown): ModelCapabilities {
  const raw = record(value);
  return {
    inputModalities: strings(raw.inputModalities ?? raw.input_modalities),
    outputModalities: strings(raw.outputModalities ?? raw.output_modalities),
    reasoningLevels: strings(raw.reasoningLevels ?? raw.reasoning_levels),
    supportsTools: typeof raw.supportsTools === "boolean" ? raw.supportsTools : typeof raw.supports_tools === "boolean" ? raw.supports_tools : undefined,
    supportsImages: typeof raw.supportsImages === "boolean" ? raw.supportsImages : typeof raw.supports_images === "boolean" ? raw.supports_images : undefined,
    forceResponseModelMapping: raw.forceResponseModelMapping === true || raw.force_response_model_mapping === true ? true : undefined,
  };
}

function mergeCapabilities(primary: ModelCapabilities, fallback: ModelCapabilities): ModelCapabilities {
  return {
    inputModalities: primary.inputModalities ?? fallback.inputModalities,
    outputModalities: primary.outputModalities ?? fallback.outputModalities,
    reasoningLevels: primary.reasoningLevels ?? fallback.reasoningLevels,
    supportsTools: primary.supportsTools ?? fallback.supportsTools,
    supportsImages: primary.supportsImages ?? fallback.supportsImages,
    forceResponseModelMapping: primary.forceResponseModelMapping ?? fallback.forceResponseModelMapping,
  };
}

export async function routeRuntimeOptions(env: Env, route: ModelRouteRow, endpoint: GatewayEndpoint): Promise<RouteRuntimeOptions> {
  const options = parseJson<Record<string, unknown>>(route.options_json, {});
  let discovered: ModelCapabilities = {};
  const row = await env.DB.prepare(
    `SELECT capabilities_json FROM discovered_models
     WHERE provider_id=? AND model_id=? AND endpoint=? AND enabled=1
     ORDER BY discovered_at DESC LIMIT 1`,
  ).bind(route.provider_id, route.upstream_model, endpoint).first<{ capabilities_json: string }>().catch(() => null);
  if (row?.capabilities_json) discovered = normalizeCapabilities(parseJson(row.capabilities_json, {}));
  const configured = normalizeCapabilities(options.capabilities ?? options.model_capabilities);
  const capabilities = mergeCapabilities(configured, discovered);
  const forceResponseModelMapping = options.force_response_model_mapping === true
    || options.forceResponseModelMapping === true
    || capabilities.forceResponseModelMapping === true;
  return { capabilities, forceResponseModelMapping };
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
  const [discoveredResult, routeResult] = await Promise.all([
    env.DB.prepare(
      `SELECT provider_id,model_id,capabilities_json,MAX(discovered_at) AS discovered_at
       FROM discovered_models WHERE enabled=1 GROUP BY provider_id,model_id`,
    ).all<{ provider_id: string; model_id: string; capabilities_json: string; discovered_at: number }>().catch(() => ({ results: [] })),
    env.DB.prepare(
      `SELECT public_model,provider_id,upstream_model,options_json
       FROM model_routes WHERE enabled=1 ORDER BY priority ASC,created_at ASC`,
    ).all<{ public_model: string; provider_id: string; upstream_model: string; options_json: string }>().catch(() => ({ results: [] })),
  ]);
  const discovered = new Map<string, ModelCapabilities>(discoveredResult.results.map((row) => [
    `${row.provider_id}/${row.model_id}`,
    normalizeCapabilities(parseJson(row.capabilities_json, {})),
  ] as const));
  const routed = new Map<string, ModelCapabilities>();
  for (const route of routeResult.results) {
    if (routed.has(route.public_model)) continue;
    const options = parseJson<Record<string, unknown>>(route.options_json, {});
    const configured = normalizeCapabilities(options.capabilities ?? options.model_capabilities);
    const upstream = discovered.get(`${route.provider_id}/${route.upstream_model}`) ?? {};
    routed.set(route.public_model, mergeCapabilities(configured, upstream));
  }
  return models.map((model) => {
    const directKey = typeof model.x_cflare_provider === "string" && typeof model.x_cflare_upstream_model === "string"
      ? `${model.x_cflare_provider}/${model.x_cflare_upstream_model}`
      : "";
    const publicModel = typeof model.id === "string" ? model.id : "";
    const capabilities = (directKey ? discovered.get(directKey) : undefined) ?? routed.get(publicModel);
    return capabilities && Object.values(capabilities).some((value) => value !== undefined)
      ? { ...model, x_cflare_capabilities: capabilities }
      : model;
  });
}
