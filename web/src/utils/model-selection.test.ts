import { describe, expect, it } from "vitest";
import { normalizeAllowedModelSelection, publicModelOptions } from "./model-selection";
import type { PublicModel } from "../types";

const models: PublicModel[] = [
  {
    id: "Claude Sonnet",
    display_name: "Claude Sonnet",
    x_cflare_provider: "qoder",
    x_cflare_upstream_model: "anon-a8f3",
  },
  { id: "codex/gpt-5", display_name: "GPT-5" },
];

describe("gateway-key model selection", () => {
  it("maps legacy Qoder anonymous values to public display names", () => {
    expect(normalizeAllowedModelSelection(["qoder/anon-a8f3", "Claude Sonnet", "codex/gpt-5"], models))
      .toEqual(["Claude Sonnet", "codex/gpt-5"]);
  });

  it("preserves unknown legacy values instead of silently dropping access", () => {
    expect(normalizeAllowedModelSelection(["qoder/unknown"], models)).toEqual(["qoder/unknown"]);
  });

  it("uses public ids as values and readable labels", () => {
    expect(publicModelOptions(models)).toEqual([
      { label: "Claude Sonnet", value: "Claude Sonnet" },
      { label: "GPT-5 · codex/gpt-5", value: "codex/gpt-5" },
    ]);
  });
});
