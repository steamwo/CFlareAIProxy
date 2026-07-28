import { describe, expect, it } from "vitest";
import { buildSessionAffinityKey, extractSessionAffinitySignal } from "./session-affinity";

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://gateway.test/v1/responses", { headers });
}

describe("session affinity signals", () => {
  it("prefers native client headers before body identifiers", () => {
    expect(extractSessionAffinitySignal(request({
      "x-claude-code-session-id": "claude-session",
      "session-id": "codex-session",
      "x-session-id": "generic-session",
    }), {
      session_id: "body-session",
      prompt_cache_key: "prompt-session",
    })).toEqual({ source: "claude", value: "claude-session" });
  });

  it("uses prompt_cache_key before Responses conversation ids", () => {
    expect(extractSessionAffinitySignal(request(), {
      prompt_cache_key: "prompt-session",
      conversation: { id: "conversation-session" },
    })).toEqual({ source: "prompt-cache", value: "prompt-session" });
  });

  it("extracts Claude Code metadata sessions from long metadata containers", () => {
    expect(extractSessionAffinitySignal(request(), {
      metadata: {
        user_id: JSON.stringify({ padding: "x".repeat(512), session_id: "claude-metadata-session" }),
      },
    })).toEqual({ source: "claude", value: "claude-metadata-session" });
  });

  it("rejects unsafe explicit identifiers and falls back safely", () => {
    expect(extractSessionAffinitySignal(request(), {
      session_id: "bad\u0000value",
      prompt_cache_key: "safe-fallback",
    })).toEqual({ source: "prompt-cache", value: "safe-fallback" });
    expect(extractSessionAffinitySignal(request({ "x-session-id": "x".repeat(257) }), {
      conversation_id: "conversation-fallback",
    })).toEqual({ source: "conversation", value: "conversation-fallback" });
  });

  it("preserves existing affinity keys for legacy signals", async () => {
    expect(await buildSessionAffinityKey(
      request({ "x-session-id": "existing-session" }),
      {},
      "tenant-a",
      "codex",
    )).toBe("codex:tenant-a:existing-session");
  });

  it("binds prompt_cache_key and conversation.id as aliases", async () => {
    const combined = await buildSessionAffinityKey(request(), {
      prompt_cache_key: "prompt-session",
      conversation: { id: "conversation-session" },
    }, "tenant-a", "codex");
    const conversationOnly = await buildSessionAffinityKey(request(), {
      conversation: { id: "conversation-session" },
    }, "tenant-a", "codex");
    expect(Array.isArray(combined)).toBe(true);
    expect(combined).toContain(conversationOnly);
  });

  it("derives a stable fallback from the initial message root", async () => {
    const body = {
      instructions: "Be precise.",
      input: [{ role: "user", content: [{ type: "input_text", text: "Explain Durable Objects" }] }],
    };
    const first = await buildSessionAffinityKey(request(), body, "tenant-a", "codex");
    const second = await buildSessionAffinityKey(request(), body, "tenant-a", "codex");
    expect(first).toBe(second);
    expect(first).toMatch(/^v2:codex:tenant-a:[a-f0-9]{64}$/);
  });

  it("namespaces the same external session by provider and gateway key", async () => {
    const body = { prompt_cache_key: "shared-external-id" };
    const left = await buildSessionAffinityKey(request(), body, "tenant-a", "codex");
    const rightTenant = await buildSessionAffinityKey(request(), body, "tenant-b", "codex");
    const rightProvider = await buildSessionAffinityKey(request(), body, "tenant-a", "kimi");
    expect(left).not.toBe(rightTenant);
    expect(left).not.toBe(rightProvider);
  });
});
