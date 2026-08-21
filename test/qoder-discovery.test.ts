import { describe, expect, it } from "vitest";
import {
  registerQoderResponsesDiscovery,
  runRegisteredQoderResponsesDiscovery,
  takeQoderDiscoveryPriorUsage,
  type QoderDiscoveryAttempt,
} from "../src/providers/qoder-discovery";
import type { QoderToolRoute } from "../src/providers/qoder-protocol";
import { projectQoderResponsesBody, qoderResponsesFunctionCandidates } from "../src/providers/qoder-tool-virtualization";

function functionTool(name: string, description = "test tool"): Record<string, unknown> {
  return { type: "function", name, description, parameters: { type: "object", properties: {} } };
}

function largeTools(count = 120): Array<Record<string, unknown>> {
  const tools = Array.from({ length: count }, (_, index) => {
    if (index === 0) return functionTool("read_file");
    if (index === 1) return functionTool("apply_patch");
    if (index === 2) return functionTool("shell_command");
    return functionTool(`mcp_tool_${index.toString().padStart(3, "0")}`);
  });
  tools[tools.length - 1] = functionTool("database_query", "Run SQL queries against the customer database");
  return tools;
}

function qoderFrame(inner: string): string {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: inner })}\n\ndata: [DONE]\n\n`;
}

function searchFrame(query: string, extraCall = false, usage = { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }): string {
  const calls: unknown[] = [{
    index: 0,
    id: "call_search",
    type: "function",
    function: { name: "tool_search", arguments: JSON.stringify({ query }) },
  }];
  if (extraCall) {
    calls.push({ index: 1, id: "call_read", type: "function", function: { name: "read_file", arguments: "{}" } });
  }
  return qoderFrame(JSON.stringify({ choices: [{ delta: { tool_calls: calls }, finish_reason: "tool_calls" }], usage }));
}

function finalTextFrame(text = "done", usage = { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }): string {
  return qoderFrame(JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }], usage }));
}

function response(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function routes(includeRead = false): Map<string, QoderToolRoute> {
  const output = new Map<string, QoderToolRoute>([["tool_search", { kind: "tool_search", name: "tool_search" }]]);
  if (includeRead) output.set("read_file", { kind: "function", name: "read_file" });
  return output;
}

function registration(
  requestId: string,
  originalBody: Record<string, unknown>,
  currentBody: Record<string, unknown>,
  currentRoutes: Map<string, QoderToolRoute>,
  builtBodies: Array<Record<string, unknown>>,
): void {
  registerQoderResponsesDiscovery(requestId, {
    originalBody,
    currentBody,
    currentRoutes,
    buildAttempt: async (body): Promise<QoderDiscoveryAttempt> => {
      builtBodies.push(body);
      return {
        request: { url: "https://qoder.test/agent", init: { method: "POST" }, responseMode: "qoder-chat" },
        routes: currentRoutes,
      };
    },
  });
}

function inputItems(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(body.input) ? body.input as Array<Record<string, unknown>> : [];
}

describe("Qoder proxy-managed Responses discovery", () => {
  it("keeps synthetic search internal, promotes matches, and accumulates hidden usage", async () => {
    const requestId = "discovery-promote";
    const tools = largeTools();
    const originalBody = { model: "Lite", input: "query the database", tools };
    const projected = projectQoderResponsesBody(originalBody);
    expect(projected.proxyManaged).toBe(true);
    const builtBodies: Array<Record<string, unknown>> = [];
    registration(requestId, originalBody, projected.body, routes(), builtBodies);

    const replies = [response(searchFrame("database")), response(finalTextFrame("database ready"))];
    let fetches = 0;
    const final = await runRegisteredQoderResponsesDiscovery(
      requestId,
      "https://qoder.test/agent",
      { method: "POST" },
      async () => replies[fetches++]!,
    );

    expect(fetches).toBe(2);
    expect(await final.text()).toContain("database ready");
    expect(builtBodies).toHaveLength(1);
    const items = inputItems(builtBodies[0]!);
    expect(items.some((item) => item.type === "tool_search_call")).toBe(true);
    const output = items.find((item) => item.type === "tool_search_output");
    expect(JSON.stringify(output)).toContain("database_query");
    expect(takeQoderDiscoveryPriorUsage(requestId)).toEqual({
      promptTokens: 5,
      completionTokens: 1,
      cachedTokens: 0,
      totalTokens: 6,
    });
  });

  it("fails open immediately when synthetic search is mixed with a real function call", async () => {
    const requestId = "discovery-mixed";
    const tools = largeTools();
    const originalBody = { model: "Lite", input: "do work", tools };
    const projected = projectQoderResponsesBody(originalBody);
    const builtBodies: Array<Record<string, unknown>> = [];
    registration(requestId, originalBody, projected.body, routes(true), builtBodies);

    const replies = [response(searchFrame("database", true)), response(finalTextFrame("full registry retry"))];
    let fetches = 0;
    const final = await runRegisteredQoderResponsesDiscovery(
      requestId,
      "https://qoder.test/agent",
      { method: "POST" },
      async () => replies[fetches++]!,
    );

    expect(fetches).toBe(2);
    expect(await final.text()).toContain("full registry retry");
    expect(builtBodies).toHaveLength(1);
    expect(qoderResponsesFunctionCandidates(builtBodies[0]?.tools)).toHaveLength(120);
    expect(takeQoderDiscoveryPriorUsage(requestId)?.totalTokens).toBe(6);
  });

  it("restores the complete registry after three unresolved search hops", async () => {
    const requestId = "discovery-limit";
    const tools = largeTools();
    const originalBody = { model: "Lite", input: "find unusual tool", tools };
    const projected = projectQoderResponsesBody(originalBody);
    const builtBodies: Array<Record<string, unknown>> = [];
    registration(requestId, originalBody, projected.body, routes(), builtBodies);

    const replies = [
      response(searchFrame("keep searching")),
      response(searchFrame("keep searching")),
      response(searchFrame("keep searching")),
      response(finalTextFrame("fallback reached")),
    ];
    let fetches = 0;
    const final = await runRegisteredQoderResponsesDiscovery(
      requestId,
      "https://qoder.test/agent",
      { method: "POST" },
      async () => replies[fetches++]!,
    );

    expect(fetches).toBe(4);
    expect(await final.text()).toContain("fallback reached");
    expect(builtBodies).toHaveLength(3);
    expect(qoderResponsesFunctionCandidates(builtBodies.at(-1)?.tools)).toHaveLength(120);
    expect(takeQoderDiscoveryPriorUsage(requestId)).toEqual({
      promptTokens: 15,
      completionTokens: 3,
      cachedTokens: 0,
      totalTokens: 18,
    });
  });
});
