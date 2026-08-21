import { describe, expect, it } from "vitest";
import {
  QODER_AUTO_TOOL_SEARCH_CORE_FLOOR,
  QODER_AUTO_TOOL_SEARCH_CORE_LIMIT,
  QODER_PROXY_TOOL_SEARCH_RESULT_MAX,
  projectQoderResponsesBody,
  qoderCandidateDisplayName,
  qoderResponsesFunctionCandidates,
  searchDeferredQoderResponsesTools,
} from "../src/providers/qoder-tool-virtualization";

function functionTool(name: string, description = "test tool"): Record<string, unknown> {
  return {
    type: "function",
    name,
    description,
    parameters: { type: "object", properties: {} },
  };
}

function makeFunctions(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => {
    if (index === 0) return functionTool("read_file");
    if (index === 1) return functionTool("apply_patch");
    if (index === 2) return functionTool("shell_command");
    return functionTool(`mcp_tool_${index.toString().padStart(3, "0")}`);
  });
}

function namespacedLargeTools(count = 120): Array<Record<string, unknown>> {
  const left = Math.floor(count / 2);
  const workspace = makeFunctions(left);
  const services = makeFunctions(count - left);
  services[services.length - 1] = functionTool("database_query", "Run SQL queries against the customer database");
  return [
    { type: "namespace", name: "workspace", description: "workspace tools", tools: workspace },
    { type: "namespace", name: "services", description: "service tools", tools: services },
  ];
}

function allTools(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(body.tools) ? body.tools as Array<Record<string, unknown>> : [];
}

describe("Qoder Responses tool virtualization", () => {
  it("virtualizes large namespaced registries without mutating the downstream request", () => {
    const tools = namespacedLargeTools();
    const original = JSON.stringify(tools);
    const projected = projectQoderResponsesBody({ model: "Lite", input: "do work", tools });

    expect(projected.proxyManaged).toBe(true);
    expect(projected.functionLeaves).toBe(120);
    expect(projected.visibleFunctions).toBeGreaterThanOrEqual(QODER_AUTO_TOOL_SEARCH_CORE_FLOOR);
    expect(projected.visibleFunctions).toBeLessThanOrEqual(QODER_AUTO_TOOL_SEARCH_CORE_LIMIT);
    expect(allTools(projected.body).some((tool) => tool.type === "tool_search" && tool.execution === "proxy")).toBe(true);
    expect(JSON.stringify(tools)).toBe(original);
  });

  it("finds deferred namespaced capabilities and returns a deterministic catalog on lexical misses", () => {
    const tools = namespacedLargeTools();
    const matches = searchDeferredQoderResponsesTools(tools, "database", QODER_PROXY_TOOL_SEARCH_RESULT_MAX);
    expect(matches.length).toBeGreaterThan(0);
    expect(qoderCandidateDisplayName(matches[0]!)).toBe("services__database_query");

    const catalog = searchDeferredQoderResponsesTools(tools, "all available tools", QODER_PROXY_TOOL_SEARCH_RESULT_MAX);
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.length).toBeLessThanOrEqual(QODER_PROXY_TOOL_SEARCH_RESULT_MAX);
    expect(searchDeferredQoderResponsesTools(tools, "totally-missing-capability", QODER_PROXY_TOOL_SEARCH_RESULT_MAX)
      .map(qoderCandidateDisplayName)).toEqual(catalog.map(qoderCandidateDisplayName));
  });

  it("leaves small registries unchanged", () => {
    const tools = makeFunctions(12);
    const projected = projectQoderResponsesBody({ model: "Lite", input: "hello", tools });
    expect(projected.proxyManaged).toBe(false);
    expect(projected.functionLeaves).toBe(12);
    expect(projected.visibleFunctions).toBe(12);
    expect(allTools(projected.body).some((tool) => tool.type === "tool_search")).toBe(false);
  });

  it("preserves a client-provided tool_search and keeps discovery client-managed", () => {
    const nativeSearch = {
      type: "tool_search",
      execution: "client",
      description: "native codex search",
      defer_loading: true,
      parameters: { type: "object", properties: {} },
    };
    const tools = [nativeSearch, ...namespacedLargeTools()];
    const projected = projectQoderResponsesBody({ model: "Lite", input: "hello", tools });
    expect(projected.proxyManaged).toBe(false);
    const searches = allTools(projected.body).filter((tool) => tool.type === "tool_search");
    expect(searches).toHaveLength(1);
    expect(searches[0]?.execution).toBe("client");
    expect(searches[0]?.description).toBe("native codex search");
    expect(searches[0]).not.toHaveProperty("defer_loading");
    expect(projected.visibleFunctions).toBeGreaterThanOrEqual(QODER_AUTO_TOOL_SEARCH_CORE_FLOOR);
    expect(projected.visibleFunctions).toBeLessThanOrEqual(QODER_AUTO_TOOL_SEARCH_CORE_LIMIT);
    expect(qoderResponsesFunctionCandidates(tools)).toHaveLength(120);
  });
});
