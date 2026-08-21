import { describe, expect, it } from "vitest";
import {
  extractClientTurnKey,
  extractSessionAffinitySignal,
  parseCodexTurnMetadata,
} from "../src/session-affinity";

describe("Qoder downstream session affinity", () => {
  it("prefers the current Codex thread from turn metadata over session fallbacks", () => {
    const request = new Request("https://gateway.test/v1/responses", {
      headers: {
        "x-codex-turn-metadata": JSON.stringify({ session_id: "root-session", thread_id: "child-thread", turn_id: "turn-42" }),
        "session-id": "session-header",
        "x-codex-window-id": "window-1",
      },
    });
    expect(extractSessionAffinitySignal(request, {})).toEqual({ source: "codex-thread", value: "child-thread" });
    expect(extractClientTurnKey(request)).toBe("codex/turn/turn-42");
  });

  it("prefers an explicit current Thread-Id over metadata thread", () => {
    const request = new Request("https://gateway.test/v1/responses", {
      headers: {
        "thread-id": "header-thread",
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "metadata-thread", turn_id: "turn-1" }),
      },
    });
    expect(extractSessionAffinitySignal(request, {})).toEqual({ source: "codex-thread", value: "header-thread" });
  });

  it("accepts Codex Thread_id as the current thread alias", () => {
    const request = new Request("https://gateway.test/v1/chat/completions", {
      headers: { "thread_id": "underscore-thread" },
    });
    expect(extractSessionAffinitySignal(request, {})).toEqual({ source: "codex-thread", value: "underscore-thread" });
  });

  it("uses prompt_cache_key as a restart-safe Responses fallback", () => {
    const request = new Request("https://gateway.test/v1/responses");
    expect(extractSessionAffinitySignal(request, { prompt_cache_key: "  cache-thread-123  " }))
      .toEqual({ source: "prompt-cache", value: "cache-thread-123" });
  });

  it("keeps missing downstream identity unbound", () => {
    const request = new Request("https://gateway.test/v1/responses");
    expect(extractSessionAffinitySignal(request, { input: "hello" })).toBeUndefined();
    expect(extractClientTurnKey(request)).toBeUndefined();
  });

  it("rejects malformed and oversized Codex turn metadata", () => {
    expect(parseCodexTurnMetadata("not-json")).toEqual({});
    expect(parseCodexTurnMetadata("x".repeat((8 << 10) + 1))).toEqual({});
  });
});
