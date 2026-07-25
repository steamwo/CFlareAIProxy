import type { Env, ProviderKind } from "./types";
import { parseJson } from "./utils";

const ALLOWED_REASONING_LEVELS = new Set(["none", "low", "medium", "high", "xhigh", "max", "ultra"]);

export interface CodexClientCatalogContext {
  multiAgentModels: Set<string>;
  providerKinds: Map<string, ProviderKind>;
}

export interface CodexClientProviderSource {
  id: string;
  kind: ProviderKind;
  options_json: string;
}

export interface CodexClientRouteSource {
  public_model: string;
  provider_id: string;
  route_options_json: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim().toLowerCase()))];
}

function modelProviders(model: Record<string, unknown>): string[] {
  if (typeof model.x_cflare_provider === "string" && model.x_cflare_provider.trim()) return [model.x_cflare_provider.trim()];
  return Array.isArray(model.x_cflare_providers)
    ? [...new Set(model.x_cflare_providers.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()))]
    : [];
}

function reasoningDescription(level: string): string {
  switch (level) {
    case "none": return "No reasoning";
    case "low": return "Fast responses with lighter reasoning";
    case "medium": return "Balances speed and reasoning depth for everyday tasks";
    case "high": return "Greater reasoning depth for complex problems";
    case "xhigh": return "Extra high reasoning depth for complex problems";
    case "max": return "Maximum available reasoning depth for complex problems";
    case "ultra": return "Maximum reasoning with automatic task delegation";
    default: return level;
  }
}

function reasoningMetadata(capabilities: Record<string, unknown>): { levels?: Array<{ effort: string; description: string }>; defaultLevel?: string } {
  const levels = stringArray(capabilities.reasoningLevels ?? capabilities.reasoning_levels)
    .filter((level) => ALLOWED_REASONING_LEVELS.has(level));
  if (levels.length === 0) return {};
  const defaultLevel = levels.includes("medium") ? "medium" : levels.find((level) => level !== "none") ?? levels[0];
  return { levels: levels.map((effort) => ({ effort, description: reasoningDescription(effort) })), defaultLevel };
}

function inputModalities(capabilities: Record<string, unknown>): string[] {
  const modalities = stringArray(capabilities.inputModalities ?? capabilities.input_modalities).filter((value) => value === "text" || value === "image");
  if (modalities.length > 0) return modalities;
  return capabilities.supportsImages === true || capabilities.supports_images === true ? ["text", "image"] : ["text"];
}

function serviceTiers(capabilities: Record<string, unknown>): Array<{ id: string; name: string; description: string }> {
  return stringArray(capabilities.serviceTiers ?? capabilities.service_tiers).map((id) => ({ id, name: id, description: id }));
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function featureFlag(options: Record<string, unknown>): boolean | undefined {
  const value = options.codex_multi_agent_v2 ?? options.codexMultiAgentV2;
  return typeof value === "boolean" ? value : undefined;
}

export function resolveCodexClientCatalogContext(
  models: Array<Record<string, unknown>>,
  providers: CodexClientProviderSource[],
  routes: CodexClientRouteSource[],
): CodexClientCatalogContext {
  const providerKinds = new Map(providers.map((row) => [row.id, row.kind] as const));
  const providerFlags = new Map(providers.map((row) => [
    row.id,
    featureFlag(parseJson<Record<string, unknown>>(row.options_json, {})) === true,
  ] as const));
  const routeFlags = new Map<string, boolean[]>();
  for (const route of routes) {
    const routeOptions = parseJson<Record<string, unknown>>(route.route_options_json, {});
    const routeFlag = featureFlag(routeOptions) ?? providerFlags.get(route.provider_id) ?? false;
    const flags = routeFlags.get(route.public_model) ?? [];
    flags.push(routeFlag);
    routeFlags.set(route.public_model, flags);
  }
  const multiAgentModels = new Set<string>();
  for (const model of models) {
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id) continue;
    const flags = routeFlags.get(id);
    if (flags?.length) {
      if (flags.every(Boolean)) multiAgentModels.add(id);
      continue;
    }
    const modelProviderIds = modelProviders(model);
    if (modelProviderIds.length === 1 && providerFlags.get(modelProviderIds[0]) === true) multiAgentModels.add(id);
  }
  return { multiAgentModels, providerKinds };
}

export async function loadCodexClientCatalogContext(env: Env, models: Array<Record<string, unknown>>): Promise<CodexClientCatalogContext> {
  const [providerResult, routeResult] = await Promise.all([
    env.DB.prepare("SELECT id,kind,options_json FROM providers WHERE enabled=1")
      .all<CodexClientProviderSource>().catch(() => ({ results: [] })),
    env.DB.prepare(
      `SELECT r.public_model,r.provider_id,r.options_json AS route_options_json
       FROM model_routes r JOIN providers p ON p.id=r.provider_id AND p.enabled=1
       WHERE r.enabled=1 AND r.endpoint='responses' ORDER BY r.public_model,r.priority,r.created_at`,
    ).all<CodexClientRouteSource>().catch(() => ({ results: [] })),
  ]);
  return resolveCodexClientCatalogContext(models, providerResult.results, routeResult.results);
}

function supportsSearchTool(model: Record<string, unknown>, capabilities: Record<string, unknown>, providerKinds: Map<string, ProviderKind>): boolean {
  if (capabilities.supportsSearchTool !== true && capabilities.supports_search_tool !== true) return false;
  const providers = modelProviders(model);
  return providers.length > 0 && providers.every((providerId) => providerKinds.get(providerId) === "codex");
}

function buildEntry(
  model: Record<string, unknown>,
  context: CodexClientCatalogContext,
  priority: number,
): Record<string, unknown> | null {
  const slug = typeof model.id === "string" ? model.id.trim() : "";
  if (!slug) return null;
  const endpoints = stringArray(model.x_cflare_endpoints);
  if (endpoints.length > 0 && !endpoints.includes("responses")) return null;
  const capabilities = record(model.x_cflare_capabilities);
  const displayName = typeof model.display_name === "string" && model.display_name.trim() ? model.display_name.trim() : slug;
  const description = typeof model.description === "string" && model.description.trim() ? model.description.trim() : displayName;
  const modalities = inputModalities(capabilities);
  const reasoning = reasoningMetadata(capabilities);
  const tiers = serviceTiers(capabilities);
  const contextWindow = positiveNumber(capabilities.contextWindow ?? capabilities.context_window);
  const configuredVisibility = typeof capabilities.visibility === "string" ? capabilities.visibility.trim().toLowerCase() : "";
  const visibility = configuredVisibility === "hide" || configuredVisibility === "list"
    ? configuredVisibility
    : modalities.includes("text") ? "list" : "hide";
  const entry: Record<string, unknown> = {
    slug,
    prefer_websockets: false,
    support_verbosity: true,
    default_verbosity: "low",
    web_search_tool_type: "text_and_image",
    input_modalities: modalities,
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_parallel_tool_calls: capabilities.supportsTools !== false && capabilities.supports_tools !== false,
    tool_mode: "code_mode_only",
    use_responses_lite: true,
    include_skills_usage_instructions: false,
    auto_review_model_override: null,
    auto_compact_token_limit: null,
    reasoning_summary_format: "experimental",
    default_reasoning_summary: "none",
    display_name: displayName,
    description,
    shell_type: "shell_command",
    visibility,
    supported_in_api: true,
    upgrade: null,
    priority,
    model_messages: {},
    experimental_supported_tools: [],
    available_in_plans: [],
    supports_search_tool: supportsSearchTool(model, capabilities, context.providerKinds),
    default_service_tier: null,
    service_tiers: tiers,
    additional_speed_tiers: [],
    supports_reasoning_summary_parameter: true,
    supports_reasoning_summaries: true,
  };
  if (modalities.includes("image")) entry.supports_image_detail_original = true;
  if (context.multiAgentModels.has(slug)) entry.multi_agent_version = "v2";
  if (contextWindow) {
    entry.context_window = contextWindow;
    entry.max_context_window = contextWindow;
  }
  if (reasoning.levels && reasoning.defaultLevel) {
    entry.supported_reasoning_levels = reasoning.levels;
    entry.default_reasoning_level = reasoning.defaultLevel;
  }
  return entry;
}

export function buildCodexClientModels(
  models: Array<Record<string, unknown>>,
  context: CodexClientCatalogContext = { multiAgentModels: new Set(), providerKinds: new Map() },
): Array<Record<string, unknown>> {
  const candidates = models.map((model) => ({
    model,
    slug: typeof model.id === "string" ? model.id.trim() : "",
    displayName: typeof model.display_name === "string" && model.display_name.trim() ? model.display_name.trim() : typeof model.id === "string" ? model.id.trim() : "",
    explicitPriority: positiveNumber(record(model.x_cflare_capabilities).priority),
  })).filter((entry) => entry.slug);
  const explicitMax = candidates.reduce((maximum, entry) => Math.max(maximum, entry.explicitPriority ?? 0), 0);
  const pending = candidates.filter((entry) => !entry.explicitPriority).sort((left, right) => {
    const display = left.displayName.toLowerCase().localeCompare(right.displayName.toLowerCase());
    return display || left.slug.localeCompare(right.slug);
  });
  const assigned = new Map(pending.map((entry, index) => [entry.slug, explicitMax + 100 * (index + 1)] as const));
  return candidates.flatMap((entry) => {
    const built = buildEntry(entry.model, context, entry.explicitPriority ?? assigned.get(entry.slug) ?? 100);
    return built ? [built] : [];
  }).sort((left, right) => Number(left.priority ?? 100) - Number(right.priority ?? 100) || String(left.slug).localeCompare(String(right.slug)));
}

export async function buildCodexClientModelsResponse(env: Env, models: Array<Record<string, unknown>>): Promise<{ models: Array<Record<string, unknown>> }> {
  const context = await loadCodexClientCatalogContext(env, models);
  return { models: buildCodexClientModels(models, context) };
}
