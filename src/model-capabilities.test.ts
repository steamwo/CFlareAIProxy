import { describe, expect, it } from "vitest";
import {
  configuredModelCapabilities,
  mergeModelCapabilities,
  normalizeCapabilities,
  validateModelCapabilities,
} from "./model-capabilities";

describe("configured model capabilities", () => {
  it("reads provider model maps and configured model arrays", () => {
    expect(configuredModelCapabilities({
      model_capabilities: {
        "gpt-map": { reasoning_levels: ["minimal", "high"], supports_tools: false },
      },
    }, "gpt-map")).toEqual(expect.objectContaining({
      reasoningLevels: ["minimal", "high"],
      supportsTools: false,
    }));

    expect(configuredModelCapabilities({
      models: [{
        id: "gpt-array",
        capabilities: { reasoningLevels: ["auto", "medium"], "max-context-length": 200000 },
      }],
    }, "gpt-array")).toEqual(expect.objectContaining({
      reasoningLevels: ["auto", "medium"],
      contextWindow: 200000,
    }));
  });

  it("accepts max context length aliases and ignores invalid overrides", () => {
    expect(normalizeCapabilities({ maxContextLength: 123456 }).contextWindow).toBe(123456);
    expect(normalizeCapabilities({ max_context_length: 234567 }).contextWindow).toBe(234567);
    expect(normalizeCapabilities({ "max-context-length": 345678 }).contextWindow).toBe(345678);
    expect(normalizeCapabilities({ "max-context-length": 0, context_window: 456789 }).contextWindow).toBe(456789);
    expect(normalizeCapabilities({ "max-context-length": -1, context_window: 567890 }).contextWindow).toBe(567890);
  });

  it("applies route, provider, then discovered precedence", () => {
    const discovered = normalizeCapabilities({
      reasoningLevels: ["low"],
      supportsTools: true,
      contextWindow: 100000,
    });
    const provider = normalizeCapabilities({
      reasoningLevels: ["auto", "medium"],
      supportsTools: false,
      "max-context-length": 150000,
    });
    const route = normalizeCapabilities({ "max-context-length": 200000 });

    expect(mergeModelCapabilities(route, mergeModelCapabilities(provider, discovered))).toEqual(expect.objectContaining({
      reasoningLevels: ["auto", "medium"],
      supportsTools: false,
      contextWindow: 200000,
    }));
  });

  it("drops unknown reasoning levels and falls back when none remain", () => {
    expect(normalizeCapabilities({
      reasoningLevels: ["invalid", "AUTO", "minimal", "none"],
    }).reasoningLevels).toEqual(["auto", "minimal", "none"]);

    const configured = normalizeCapabilities({ reasoningLevels: ["invalid"] });
    const discovered = normalizeCapabilities({ reasoningLevels: ["low", "high"] });
    expect(mergeModelCapabilities(configured, discovered).reasoningLevels).toEqual(["low", "high"]);
  });

  it("applies the effective reasoning levels during execution", () => {
    expect(() => validateModelCapabilities(
      { reasoning: { effort: "auto" } },
      { reasoningLevels: ["auto", "medium"] },
    )).not.toThrow();

    expect(() => validateModelCapabilities(
      { reasoning_effort: "high" },
      { reasoningLevels: ["auto", "medium"] },
    )).toThrowError(/does not support reasoning level high/);
  });
});
