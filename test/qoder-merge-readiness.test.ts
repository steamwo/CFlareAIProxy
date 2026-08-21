import { describe, expect, it } from "vitest";
import {
  buildSessionAffinityKey,
  extractSessionAffinitySignal,
} from "../src/session-affinity";
import { qoderSessionId } from "../src/providers/qoder-identity";
import {
  registerQoderResponsesDiscovery,
  runRegisteredQoderResponsesDiscovery,
  type QoderDiscoveryAttempt,
} from "../src/providers/qoder-discovery";
import type { QoderToolRoute } from "../src/providers/qoder-protocol";
import { projectQoderResponsesBody } from "../src/providers/qoder-tool-virtualization";

function responseRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://gateway.test/v1/responses", { headers });
}

function messagesRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://gateway.test/v1/messages", { headers });
}

function functionTool(name: string, description = "tool"): Record<string, unknown> {
  return { type: "function", name, description, parameters: { type: "object", properties: { value: { type: "string" } } } };
}

function largeTools(): Array<Record<string, unknown>> {
  const tools = Array.from({ length: 96 }, (_, index) => functionTool(`tool_${index.toString().padStart(3, "0")}`));
  tools[95] = functionTool("database_query", "Query the customer database");
  return tools;
}

function qoderFrame(inner: Record<string, unknown>): Response {
  return new Response(
    `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(inner) })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("Qoder merge-readiness identity parity", () => {
  it("separates Claude Code child agents while ignoring parent-agent relationship metadata", async () => {
    const body = { model: "qoder", max_tokens: 100, messages: [{ role: "user", content: "work" }] };
    const child = messagesRequest({
      "x-claude-code-session-id": "session-main",
      "x-claude-code-agent-id": "agent-child",
      "x-claude-code-parent-agent-id": "agent-parent-a",
    });
    const sameChildDifferentParent = messagesRequest({
      "x-claude-code-session-id": "session-main",
      "x-claude-code-agent-id": "agent-child",
      "x-claude-code-parent-agent-id": "agent-parent-b",
    });
    const sibling = messagesRequest({
      "x-claude-code-session-id": "session-main",
      "x-claude-code-agent-id": "agent-sibling",
    });

    const childId = await qoderSessionId(child, body, "model-a");
    expect(await qoderSessionId(sameChildDifferentParent, body, "model-b")).toBe(childId);
    expect(await qoderSessionId(sibling, body, "model-a")).not.toBe(childId);
  });

  it("canonicalizes Codex Session-Id and turn-metadata session_id", async () => {
    const body = { model: "qoder", input: "continue" };
    const headerRequest = responseRequest({ "session-id": "session-123" });
    const metadataRequest = responseRequest({
      "x-codex-turn-metadata": JSON.stringify({ session_id: "session-123", turn_id: "turn-2" }),
    });

    expect(await qoderSessionId(headerRequest, body, "lite"))
      .toBe(await qoderSessionId(metadataRequest, body, "pro"));

    const headerAffinity = await buildSessionAffinityKey(headerRequest, body, "tenant", "qoder");
    const metadataAffinity = await buildSessionAffinityKey(metadataRequest, body, "tenant", "qoder");
    const left = new Set(Array.isArray(headerAffinity) ? headerAffinity : [headerAffinity]);
    const right = new Set(Array.isArray(metadataAffinity) ? metadataAffinity : [metadataAffinity]);
    expect([...left].some((key) => key !== undefined && right.has(key))).toBe(true);
  });

  it("prefers stable Codex thread and prompt-cache identity over request-scoped compatibility headers", async () => {
    const withThread = responseRequest({
      "thread-id": "thread-current",
      "x-claude-code-session-id": "stray-compat-session",
    });
    expect(extractSessionAffinitySignal(withThread, {})).toEqual({ source: "codex-thread", value: "thread-current" });

    const first = responseRequest({ "x-client-request-id": "request-1" });
    const second = responseRequest({ "x-client-request-id": "request-2" });
    const body = { model: "qoder", input: "continue", prompt_cache_key: "cache-thread" };
    expect(extractSessionAffinitySignal(first, body)).toEqual({ source: "prompt-cache", value: "cache-thread" });
    expect(await qoderSessionId(first, body, "lite")).toBe(await qoderSessionId(second, body, "pro"));
  });
});

describe("Qoder merge-readiness hidden discovery parity", () => {
  it("keeps hidden tool-result messages compact while promoting full schemas separately", async () => {
    const requestId = "compact-discovery";
    const originalBody = { model: "Lite", input: "query the database", tools: largeTools() };
    const projected = projectQoderResponsesBody(originalBody);
    expect(projected.proxyManaged).toBe(true);

    const builtBodies: Array<Record<string, unknown>> = [];
    const routes = new Map<string, QoderToolRoute>([["tool_search", { kind: "tool_search", name: "tool_search" }]]);
    registerQoderResponsesDiscovery(requestId, {
      originalBody,
      currentBody: projected.body,
      currentRoutes: routes,
      buildAttempt: async (body): Promise<QoderDiscoveryAttempt> => {
        builtBodies.push(body);
        return {
          request: { url: "https://qoder.test/agent", init: { method: "POST" }, responseMode: "qoder-chat" },
          routes,
        };
      },
    });

    const replies = [
      qoderFrame({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_search",
              type: "function",
              function: { name: "tool_search", arguments: JSON.stringify({ query: "database" }) },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }),
      qoderFrame({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }),
    ];
    let fetches = 0;
    await runRegisteredQoderResponsesDiscovery(
      requestId,
      "https://qoder.test/agent",
      { method: "POST" },
      async () => replies[fetches++]!,
    );

    expect(builtBodies).toHaveLength(1);
    const input = builtBodies[0]!.input as Array<Record<string, unknown>>;
    const searchOutput = input.find((item) => item.type === "tool_search_output");
    const additional = input.find((item) => item.type === "additional_tools");
    expect(searchOutput?.tools).toEqual({
      query: "database",
      count: 1,
      matched_tools: [{ name: "database_query" }],
    });
    expect(JSON.stringify(searchOutput?.tools)).not.toContain("parameters");
    expect(JSON.stringify(additional?.tools)).toContain("parameters");
    expect(JSON.stringify(additional?.tools)).toContain("database_query");
  });
});
