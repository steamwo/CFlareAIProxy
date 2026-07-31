import type { ModelRoute } from "../types";

export interface EndpointState {
  endpoint: string;
  availability?: ModelRoute["availability"];
}
export interface RouteDisplay extends ModelRoute {
  endpoints: string[];
  routeIds: string[];
  endpointStates: EndpointState[];
}
export interface RouteGroup {
  publicModel: string;
  routes: RouteDisplay[];
}
export type RouteStatus = "ready" | "degraded" | "unavailable";
export interface StatusMeta {
  type: "success" | "warning" | "error";
  label: string;
}

const ENDPOINT_ORDER = new Map([["responses", 0], ["chat", 1], ["completions", 2]]);

export const ENDPOINT_LABELS: Record<string, string> = {
  responses: "Responses",
  chat: "Chat Completions",
  completions: "Legacy Completions",
};

export const endpointLabel = (endpoint: string): string => ENDPOINT_LABELS[endpoint] ?? endpoint;

export function sortEndpoint(left: string, right: string): number {
  return (ENDPOINT_ORDER.get(left) ?? 99) - (ENDPOINT_ORDER.get(right) ?? 99) || left.localeCompare(right);
}

export function parseOptions(row: ModelRoute): Record<string, unknown> {
  try {
    return JSON.parse(row.options_json || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Routes created and owned by provider model selection cannot be edited by hand. */
export function managed(row: ModelRoute): boolean {
  return parseOptions(row).managed_by === "provider-model-selection";
}

export function multiAgentEnabled(row: ModelRoute): boolean {
  const options = parseOptions(row);
  return options.codex_multi_agent_v2 === true || options.codexMultiAgentV2 === true;
}

/**
 * Collapses provider-managed rows that differ only by endpoint into a single line, so one
 * logical route with three protocols renders once instead of three times.
 */
export function buildDisplayRows(rows: readonly ModelRoute[]): RouteDisplay[] {
  const output: RouteDisplay[] = [];
  const managedGroups = new Map<string, RouteDisplay>();
  for (const row of rows) {
    const display: RouteDisplay = {
      ...row,
      endpoints: [row.endpoint],
      routeIds: [row.id],
      endpointStates: [{ endpoint: row.endpoint, availability: row.availability }],
    };
    if (!managed(row)) {
      output.push(display);
      continue;
    }
    // NUL separator: ids and option JSON may contain printable punctuation, so a visible
    // separator could let two different field splits collapse into the same group key.
    const key = [row.public_model, row.provider_id, row.upstream_model, row.priority, row.weight, row.enabled, row.options_json].join("\u0000");
    const existing = managedGroups.get(key);
    if (!existing) {
      managedGroups.set(key, display);
      output.push(display);
      continue;
    }
    if (!existing.endpoints.includes(row.endpoint)) existing.endpoints.push(row.endpoint);
    existing.routeIds.push(row.id);
    existing.endpointStates.push({ endpoint: row.endpoint, availability: row.availability });
  }
  return output.map((row) => ({
    ...row,
    endpoints: [...row.endpoints].sort(sortEndpoint),
    endpointStates: [...row.endpointStates].sort((left, right) => sortEndpoint(left.endpoint, right.endpoint)),
  }));
}

/** Groups display rows by the model name clients request, filtered by a free-text query. */
export function buildRouteGroups(
  displayRows: readonly RouteDisplay[],
  query: string,
  sourceLabel: (providerId: string) => string,
): RouteGroup[] {
  const normalizedQuery = query.trim().toLowerCase();
  const groups = new Map<string, RouteDisplay[]>();
  for (const row of displayRows) {
    const searchable = `${row.public_model} ${row.provider_id} ${sourceLabel(row.provider_id)} ${row.upstream_model} ${row.endpoints.join(" ")}`.toLowerCase();
    if (normalizedQuery && !searchable.includes(normalizedQuery)) continue;
    const routes = groups.get(row.public_model) ?? [];
    routes.push(row);
    groups.set(row.public_model, routes);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([publicModel, routes]) => ({
      publicModel,
      routes: routes.sort((left, right) => left.priority - right.priority || right.weight - left.weight),
    }));
}

export function statusRank(status?: string): number {
  return status === "unavailable" ? 2 : status === "degraded" ? 1 : 0;
}

/** A grouped route is only as healthy as its worst endpoint. */
export function combinedStatus(row: RouteDisplay): RouteStatus {
  const worst = row.endpointStates.reduce((current, item) => Math.max(current, statusRank(item.availability?.status)), 0);
  return worst === 2 ? "unavailable" : worst === 1 ? "degraded" : "ready";
}

export function statusMeta(row: RouteDisplay): StatusMeta {
  const state = combinedStatus(row);
  if (state === "ready") return { type: "success", label: "可用" };
  if (state === "degraded") return { type: "warning", label: "部分可用" };
  return { type: "error", label: "已摘除" };
}

/** Explains the status: the failing endpoints if any, otherwise the account headroom. */
export function availabilityDetail(row: RouteDisplay): string {
  const problems = row.endpointStates.filter((item) => item.availability?.status && item.availability.status !== "ready");
  if (problems.length) {
    return problems
      .map((item) => `${endpointLabel(item.endpoint)}：${item.availability?.reason || (item.availability?.status === "degraded" ? "部分可用" : "不可用")}`)
      .join("；");
  }
  const values = row.endpointStates
    .map((item) => item.availability)
    .filter((value): value is NonNullable<ModelRoute["availability"]> => Boolean(value));
  if (!values.length) return "等待运行数据";
  const available = Math.min(...values.map((value) => value.availableCredentials));
  const total = Math.max(...values.map((value) => value.totalCredentials));
  return `${available}/${total} 个账号可用`;
}

/** Latest retry deadline across the grouped endpoints; 0 when none is pending. */
export function retryAt(row: RouteDisplay): number {
  return Math.max(0, ...row.endpointStates.map((item) => item.availability?.retryAt ?? 0));
}

export function formatRetry(value?: number): string {
  return value ? new Date(value * 1000).toLocaleString("zh-CN", { hour12: false }) : "";
}
