import { describe, expect, it } from "vitest";
import { buildCodexClientModels } from "./codex-client-models";
import { normalizeCapabilities } from "./model-capabilities";

describe("Codex client model schema capabilities", () => {
  it("normalizes the new upstream schema fields without flattening structured values", () => {
    const capabilities = normalizeCapabilities({
      multi_agent_reasoning_effort: null,
      requires_sandboxed_review: false,
      persistent_instructions: ["keep this", { mode: "strict" }],
      guardian_v2: { enabled: true, mode: "review" },
      confirmation_policies: [{ kind: "tool", mode: "ask" }],
    });

    expect(capabilities).toMatchObject({
      multiAgentReasoningEffort: null,
      requiresSandboxedReview: false,
      persistentInstructions: ["keep this", { mode: "strict" }],
      guardianV2: { enabled: true, mode: "review" },
      confirmationPolicies: [{ kind: "tool", mode: "ask" }],
    });
  });

  it("emits explicitly configured top-level and model_messages fields in the Codex catalog", () => {
    const capabilities = normalizeCapabilities({
      multiAgentReasoningEffort: "high",
      requiresSandboxedReview: true,
      persistentInstructions: "persistent",
      guardianV2: { enabled: true },
      confirmationPolicies: [{ action: "shell", policy: "confirm" }],
    });
    const [entry] = buildCodexClientModels([{
      id: "gpt-test",
      x_cflare_endpoints: ["responses"],
      x_cflare_capabilities: capabilities,
    }]);

    expect(entry).toMatchObject({
      multi_agent_reasoning_effort: "high",
      requires_sandboxed_review: true,
      model_messages: {
        persistent_instructions: "persistent",
        guardian_v2: { enabled: true },
        confirmation_policies: [{ action: "shell", policy: "confirm" }],
      },
    });
  });

  it("preserves explicit null while omitting fields that were never configured", () => {
    const [withNull] = buildCodexClientModels([{
      id: "gpt-null",
      x_cflare_endpoints: ["responses"],
      x_cflare_capabilities: normalizeCapabilities({
        multi_agent_reasoning_effort: null,
        persistent_instructions: null,
        guardian_v2: null,
        confirmation_policies: null,
      }),
    }]);
    expect(withNull.multi_agent_reasoning_effort).toBeNull();
    expect(withNull.model_messages).toEqual({
      persistent_instructions: null,
      guardian_v2: null,
      confirmation_policies: null,
    });

    const [missing] = buildCodexClientModels([{
      id: "gpt-missing",
      x_cflare_endpoints: ["responses"],
      x_cflare_capabilities: {},
    }]);
    expect(missing).not.toHaveProperty("multi_agent_reasoning_effort");
    expect(missing).not.toHaveProperty("requires_sandboxed_review");
    expect(missing.model_messages).toEqual({});
  });
});
