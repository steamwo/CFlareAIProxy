import { describe, expect, it } from "vitest";
import { normalizeAllowedModelSelection } from "../web/src/utils/model-selection";
import type { PublicModel } from "../web/src/types";

const codex: PublicModel = {
  id: "codex/gpt-5",
  display_name: "GPT-5",
  x_cflare_provider: "codex",
  x_cflare_upstream_model: "gpt-5",
};
const qoder: PublicModel = {
  id: "Claude Sonnet",
  display_name: "Claude Sonnet",
  x_cflare_provider: "qoder",
  x_cflare_upstream_model: "anon-a8f3",
};

describe("gateway key model selection", () => {
  it("normalizes available legacy Qoder IDs and removes unavailable values", () => {
    expect(normalizeAllowedModelSelection([
      "qoder/anon-a8f3",
      "Claude Sonnet",
      "retired/model",
      "codex/gpt-5",
    ], [qoder, codex])).toEqual([
      "Claude Sonnet",
      "codex/gpt-5",
    ]);
  });

  it("does not show stored Qoder restrictions after Qoder becomes unavailable", () => {
    expect(normalizeAllowedModelSelection([
      "Claude Sonnet",
      "qoder/anon-a8f3",
      "codex/gpt-5",
    ], [codex])).toEqual(["codex/gpt-5"]);
  });
});
