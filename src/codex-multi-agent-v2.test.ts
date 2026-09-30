import { describe, expect, it } from "vitest";
import {
  codexMultiAgentModelProfiles,
  isCodexMultiAgentClient,
  optimizeCodexMultiAgentV2Body,
  restoreCollaborationNamespaceValue,
  rewriteCodexOrphanDelegationInput,
} from "./codex-multi-agent-v2";

const models = [
  { id: "gpt-5.5", description: "Primary coding model", reasoningLevels: ["low", "medium", "high"], serviceTiers: ["default", "priority"] },
  { id: "coding-fast", reasoningLevels: ["low"] },
];

function requestBody(): Record<string, unknown> {
  return {
    model: "gpt-5.5",
    input: [
      { type: "agent_message", content: [{ type: "encrypted_content", encrypted_content: "agent payload" }] },
      {
        type: "additional_tools",
        tools: [{ type: "namespace", name: "collaboration", tools: [{
          type: "function",
          name: "spawn_agent",
          description: "Spawns an agent to work on a task.",
          parameters: {
            type: "object",
            properties: { message: { type: "object", properties: { text: { type: "string" }, encrypted: { type: "string" } }, required: ["text", "encrypted"] } },
          },
        }] }],
      },
    ],
  };
}

function requiredRecord(value: Record<string, unknown> | undefined, label: string): Record<string, unknown> {
  if (!value) throw new Error(`Expected ${label}`);
  return value;
}

describe("Codex multi-agent v2", () => {
  it("matches only official Codex desktop clients", () => {
    expect(isCodexMultiAgentClient("Codex Desktop/1.2.3")).toBe(true);
    expect(isCodexMultiAgentClient("codex-tui/0.9.0")).toBe(true);
    expect(isCodexMultiAgentClient("Mozilla/5.0 Codex Desktop/1.2.3")).toBe(false);
  });

  it("keeps the request unchanged while the feature is disabled", () => {
    const body = requestBody();
    const result = optimizeCodexMultiAgentV2Body(body, {
      enabled: false,
      endpoint: "responses",
      providerKind: "codex",
      userAgent: "Codex Desktop/1.2.3",
      models,
    });
    expect(result.body).toBe(body);
    expect(result.collaborationNamespaceOptimized).toBe(false);
  });

  it("normalizes agent messages, rewrites spawn_agent, and renames collaboration safely", () => {
    const result = optimizeCodexMultiAgentV2Body(requestBody(), {
      enabled: true,
      endpoint: "responses",
      providerKind: "codex",
      userAgent: "Codex Desktop/1.2.3",
      models,
    });
    const input = result.body.input as Array<Record<string, unknown>>;
    const message = requiredRecord(input[0], "agent message");
    expect(message.type).toBe("agent_message");
    expect(message.content).toEqual([{ type: "input_text", text: "agent payload" }]);
    const additionalTools = requiredRecord(input[1], "additional tools input");
    const namespace = requiredRecord((additionalTools.tools as Array<Record<string, unknown>>)[0], "collaboration namespace");
    expect(namespace.name).toBe("collaboration-optimize");
    const spawnAgent = requiredRecord((namespace.tools as Array<Record<string, unknown>>)[0], "spawn_agent tool");
    expect(spawnAgent.description).toContain("Available model overrides");
    expect(spawnAgent.description).toContain("`gpt-5.5`");
    expect(spawnAgent.description).toContain("Reasoning efforts: low, medium, high.");
    const messageSchema = (((spawnAgent.parameters as Record<string, unknown>).properties as Record<string, unknown>).message as Record<string, unknown>);
    expect(messageSchema.properties).toEqual({ text: { type: "string" } });
    expect(messageSchema.required).toEqual(["text"]);
    expect(result.collaborationNamespaceOptimized).toBe(true);
  });

  it("converts agent_message to a standard user message for non-Codex upstreams", () => {
    const result = optimizeCodexMultiAgentV2Body(requestBody(), {
      enabled: true,
      endpoint: "responses",
      providerKind: "openai-compatible",
      userAgent: "codex-tui/0.9.0",
      models,
    });
    const message = requiredRecord((result.body.input as Array<Record<string, unknown>>)[0], "converted user message");
    expect(message.type).toBe("message");
    expect(message.role).toBe("user");
  });

  it("does not touch collaboration tools when the optimized namespace already conflicts", () => {
    const body = requestBody();
    body.tools = [{ type: "namespace", name: "collaboration-optimize", tools: [] }];
    const result = optimizeCodexMultiAgentV2Body(body, {
      enabled: true,
      endpoint: "responses",
      providerKind: "codex",
      userAgent: "Codex Desktop/1.2.3",
      models,
    });
    const input = result.body.input as Array<Record<string, unknown>>;
    const additionalTools = requiredRecord(input[1], "additional tools input");
    const namespace = requiredRecord((additionalTools.tools as Array<Record<string, unknown>>)[0], "collaboration namespace");
    const spawnAgent = requiredRecord((namespace.tools as Array<Record<string, unknown>>)[0], "spawn_agent tool");
    expect(namespace.name).toBe("collaboration");
    expect(spawnAgent.description).toBe("Spawns an agent to work on a task.");
    expect(result.collaborationNamespaceOptimized).toBe(false);
    const message = requiredRecord(input[0], "normalized agent message");
    const content = requiredRecord((message.content as Array<Record<string, unknown>>)[0], "normalized agent content");
    expect(content).toEqual({ type: "input_text", text: "agent payload" });
  });

  it("rewrites only orphan codex_app delegation outputs behind the explicit compatibility gate", () => {
    const body = {
      input: [
        { type: "function_call", call_id: "paired", namespace: "codex_app", name: "create_thread" },
        { type: "function_call_output", call_id: "paired", namespace: "codex_app", name: "create_thread", output: "paired output" },
        { type: "function_call_output", call_id: "missing", namespace: "codex_app", name: "send_message_to_thread", output: { ok: true } },
        { type: "function_call_output", namespace: "codex_app", name: "create_thread", output: "blank id" },
        { type: "function_call_output", call_id: "other", namespace: "other", name: "create_thread", output: "untouched" },
      ],
    };

    expect(rewriteCodexOrphanDelegationInput(body, false, "collab_spawn")).toBe(body);
    expect(rewriteCodexOrphanDelegationInput(body, true, "other")).toBe(body);

    const rewritten = rewriteCodexOrphanDelegationInput(body, true, "COLLAB_SPAWN");
    const input = rewritten.input as Array<Record<string, unknown>>;
    expect(input[1]).toEqual(body.input[1]);
    expect(input[2]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: 'Tool output from codex_app__send_message_to_thread:\n{"ok":true}' }],
    });
    expect(input[3]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Tool output from codex_app__create_thread:\nblank id" }],
    });
    expect(input[4]).toEqual(body.input[4]);
  });

  it("consumes duplicate matching call ids deterministically and rewrites only excess outputs", () => {
    const rewritten = rewriteCodexOrphanDelegationInput({
      input: [
        { type: "function_call", call_id: "dup", namespace: "codex_app", name: "create_thread" },
        { type: "function_call_output", call_id: "dup", namespace: "codex_app", name: "create_thread", output: "first" },
        { type: "function_call_output", call_id: "dup", namespace: "codex_app", name: "create_thread", output: "second" },
      ],
    }, true, "collab_spawn");
    const input = rewritten.input as Array<Record<string, unknown>>;
    expect(input[1]?.type).toBe("function_call_output");
    expect(input[2]?.type).toBe("message");
  });

  it("restores optimized collaboration names without rewriting tool arguments", () => {
    expect(restoreCollaborationNamespaceValue({
      type: "response.output_item.done",
      item: { type: "function_call", namespace: "collaboration-optimize", name: "collaboration-optimize__spawn_agent", arguments: '{"name":"collaboration-optimize__literal"}' },
    })).toEqual({
      type: "response.output_item.done",
      item: { type: "function_call", namespace: "collaboration", name: "collaboration__spawn_agent", arguments: '{"name":"collaboration-optimize__literal"}' },
    });
  });

  it("builds model profiles only from routable Responses models", () => {
    expect(codexMultiAgentModelProfiles([
      { id: "responses-model", display_name: "Responses Model", x_cflare_endpoints: ["responses"], x_cflare_capabilities: { reasoningLevels: ["medium"], service_tiers: ["priority"] } },
      { id: "chat-only", x_cflare_endpoints: ["chat"] },
    ])).toEqual([{ id: "responses-model", description: "Responses Model", reasoningLevels: ["medium"], serviceTiers: ["priority"] }]);
  });
});
