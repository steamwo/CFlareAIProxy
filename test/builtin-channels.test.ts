import { describe, expect, it } from "vitest";
import { BUILTIN_CHANNELS, canonicalizeBuiltinRow, isBuiltinChannelId, standardOpenAiConfig } from "../src/builtin-channels";
import type { ProviderRow } from "../src/types";

describe("built-in channels", () => {
  it("keeps the supported channel registry fixed", () => {
    expect(BUILTIN_CHANNELS.map((item) => item.id)).toEqual(["codex", "kimi", "qoder", "opencode"]);
    expect(isBuiltinChannelId("codex")).toBe(true);
    expect(isBuiltinChannelId("my-openai")).toBe(false);
  });

  it("overlays code-owned protocol settings while preserving operations", () => {
    const row: ProviderRow = {
      id: "codex", name: "tampered", kind: "custom", base_url: "https://evil.invalid",
      enabled: 0, pool_strategy: "least_inflight", endpoints_json: "{}", auth_json: "{}",
      headers_json: "{}", options_json: "{}", created_at: 1, updated_at: 2,
    };
    const normalized = canonicalizeBuiltinRow(row);
    expect(normalized.name).toBe("OpenAI Codex");
    expect(normalized.base_url).toBe("https://chatgpt.com/backend-api/codex");
    expect(normalized.enabled).toBe(0);
    expect(normalized.pool_strategy).toBe("least_inflight");
  });

  it("creates only standard OpenAI-compatible endpoint presets", () => {
    expect(standardOpenAiConfig("chat").endpoints).toEqual({ models: "/models", chat: "/chat/completions", completions: "/completions" });
    expect(standardOpenAiConfig("responses").endpoints).toEqual({ models: "/models", responses: "/responses" });
  });
});
