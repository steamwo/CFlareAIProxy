import { describe, expect, it } from "vitest";
import { buildSessionAffinityKey, extractSessionAffinitySignals, qoderClientSessionKey } from "../src/session-affinity";

function req(path="/v1/responses", headers: Record<string,string> = {}): Request {
  return new Request(`https://gateway.example${path}`, { method: "POST", headers });
}

describe("explicit nested session hierarchy", () => {
  it("falls back from empty top-level session fields to nested request.sessionId", () => {
    expect(extractSessionAffinitySignals(req(), {
      sessionId: "   ",
      request: { sessionId: "nested-session" },
    })).toEqual([{ source: "session", value: "nested-session" }]);
  });

  it("isolates subagents from the parent session binding", async () => {
    const parentBody = { sessionId: "parent-session" };
    const childBody = { sessionId: "parent-session", metadata: { subagent_id: "child-1" } };
    expect(extractSessionAffinitySignals(req(), childBody)).toEqual([
      { source: "session-agent", value: JSON.stringify(["parent-session", "child-1"]) },
    ]);
    const parentKey = await buildSessionAffinityKey(req(), parentBody, "gateway", "provider");
    const childKey = await buildSessionAffinityKey(req(), childBody, "gateway", "provider");
    expect(childKey).not.toEqual(parentKey);
    expect(await buildSessionAffinityKey(req(), childBody, "gateway", "provider")).toEqual(childKey);
  });

  it("scopes Codex header aliases by subagent identity instead of retaining the parent binding", async () => {
    const request = req("/v1/responses", { "session-id": "parent-session" });
    const parentSignals = extractSessionAffinitySignals(request, {});
    const childBody = { metadata: { subagent_id: "child-header" } };
    const childSignals = extractSessionAffinitySignals(request, childBody);

    expect(parentSignals).toEqual([
      { source: "codex", value: "parent-session" },
      { source: "codex-session", value: "parent-session" },
    ]);
    expect(childSignals).toEqual([
      { source: "codex-agent", value: JSON.stringify(["parent-session", "child-header"]) },
      { source: "codex-session-agent", value: JSON.stringify(["parent-session", "child-header"]) },
    ]);
    expect(childSignals).not.toContainEqual({ source: "codex", value: "parent-session" });

    const parentKey = await buildSessionAffinityKey(request, {}, "gateway", "provider");
    const childKey = await buildSessionAffinityKey(request, childBody, "gateway", "provider");
    expect(childKey).not.toEqual(parentKey);
  });

  it("uses nested prompt_cache_key and metadata.user_id without content-derived fallback", () => {
    expect(extractSessionAffinitySignals(req(), { request: { prompt_cache_key: "cache-1" } }))
      .toEqual([{ source: "prompt-cache", value: "cache-1" }]);
    expect(extractSessionAffinitySignals(req(), { request: { metadata: { user_id: "user-1" } } }))
      .toEqual([{ source: "metadata-user", value: "user-1" }]);
    expect(extractSessionAffinitySignals(req(), { messages: [{ role: "user", content: "same prompt" }] })).toEqual([]);
  });

  it("uses an agent-only explicit signal when no parent session signal exists", () => {
    expect(extractSessionAffinitySignals(req(), { request: { metadata: { agent_id: "agent-7" } } }))
      .toEqual([{ source: "agent", value: "agent-7" }]);
  });

  it("keeps Qoder upstream identity aligned with nested session and agent hierarchy", () => {
    expect(qoderClientSessionKey(req(), {
      request: { sessionId: "nested-session", metadata: { subagent_id: "child-2" } },
    })).toBe("codex/session/nested-session/agent/child-2");
    expect(qoderClientSessionKey(req(), {
      request: { prompt_cache_key: "cache-2", metadata: { agent_id: "agent-2" } },
    })).toBe("openai-responses/prompt-cache/cache-2/agent/agent-2");
  });

  it("rejects control characters and overlong nested identifiers", () => {
    expect(extractSessionAffinitySignals(req(), { request: { sessionId: "bad\nvalue" } })).toEqual([]);
    expect(extractSessionAffinitySignals(req(), { request: { sessionId: "x".repeat(257) } })).toEqual([]);
  });
});