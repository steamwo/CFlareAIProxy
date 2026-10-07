import { describe, expect, it } from "vitest";
import { buildCodexClientModels, resolveCodexClientCatalogContext } from "./codex-client-models";

describe("Codex client model catalog", () => {
  it("builds the Codex client response from routable model capabilities", () => {
    const models = buildCodexClientModels([{
      id: "coding-pro",
      display_name: "Coding Pro",
      description: "Primary coding route",
      x_cflare_provider: "codex",
      x_cflare_endpoints: ["responses"],
      x_cflare_capabilities: {
        inputModalities: ["text", "image", "audio"],
        reasoningLevels: ["invalid", "auto", "minimal", "low", "medium", "high"],
        serviceTiers: ["priority"],
        contextWindow: 128000,
        visibility: "list",
        supportsSearchTool: true,
        priority: 10,
      },
    }], {
      multiAgentModels: new Set(["coding-pro"]),
      providerKinds: new Map([["codex", "codex"]]),
      searchSupport: new Map([["coding-pro", true]]),
    });

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      slug: "coding-pro",
      display_name: "Coding Pro",
      description: "Primary coding route",
      prefer_websockets: false,
      multi_agent_version: "v2",
      input_modalities: ["text", "image"],
      supports_image_detail_original: true,
      context_window: 128000,
      max_context_window: 128000,
      max_context_length: 128000,
      visibility: "list",
      priority: 10,
      supports_search_tool: true,
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "auto", description: "Automatically select the reasoning depth" },
        { effort: "minimal", description: "Fastest responses with minimal reasoning" },
        { effort: "low", description: "Fast responses with lighter reasoning" },
        { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
        { effort: "high", description: "Greater reasoning depth for complex problems" },
      ],
      service_tiers: [{ id: "priority", name: "priority", description: "priority" }],
    });
  });

  it("preserves an empty supported reasoning levels array", () => {
    const [model] = buildCodexClientModels([{
      id: "budget-only",
      x_cflare_endpoints: ["responses"],
      x_cflare_capabilities: {},
    }], undefined, "0.153.3");
    expect(model).toMatchObject({ supported_reasoning_levels: [] });
    expect(model).not.toHaveProperty("default_reasoning_level");
  });

  it("preserves an empty array when legacy filtering removes all reasoning levels", () => {
    const [model] = buildCodexClientModels([{
      id: "extended-only",
      x_cflare_endpoints: ["responses"],
      x_cflare_capabilities: { reasoningLevels: ["max", "ultra"] },
    }], undefined, "0.143.9");
    expect(model).toMatchObject({ supported_reasoning_levels: [] });
    expect(model).not.toHaveProperty("default_reasoning_level");
  });

  it("uses max context length overrides before legacy aliases", () => {
    const [model] = buildCodexClientModels([{
      id: "large-context",
      x_cflare_endpoints: ["responses"],
      x_cflare_capabilities: {
        "max-context-length": 200000,
        contextWindow: 128000,
      },
    }]);
    expect(model).toMatchObject({
      context_window: 200000,
      max_context_window: 200000,
      max_context_length: 200000,
    });
  });

  it("uses auto as the default when it is the only usable reasoning mode", () => {
    const models = buildCodexClientModels([{
      id: "automatic",
      x_cflare_endpoints: ["responses"],
      x_cflare_capabilities: { reasoningLevels: ["none", "auto"] },
    }]);
    expect(models[0]).toMatchObject({
      default_reasoning_level: "auto",
      supported_reasoning_levels: [
        { effort: "none", description: "No reasoning" },
        { effort: "auto", description: "Automatically select the reasoning depth" },
      ],
    });
  });

  it("assigns stable priorities after explicit metadata and excludes chat-only models", () => {
    const models = buildCodexClientModels([
      { id: "beta", display_name: "Beta", x_cflare_endpoints: ["responses"] },
      { id: "chat-only", display_name: "Chat Only", x_cflare_endpoints: ["chat"] },
      { id: "pinned", display_name: "Pinned", x_cflare_endpoints: ["responses"], x_cflare_capabilities: { priority: 5 } },
      { id: "alpha", display_name: "Alpha", x_cflare_endpoints: ["responses"] },
    ]);
    expect(models.map((model) => [model.slug, model.priority])).toEqual([
      ["pinned", 5],
      ["alpha", 105],
      ["beta", 205],
    ]);
  });

  it("aggregates explicit search support conservatively across Responses routes", () => {
    const providers = [
      {
        id: "codex", kind: "codex" as const,
        options_json: JSON.stringify({ model_capabilities: { upstream: { supports_search_tool: true } } }),
      },
      { id: "openai-main", kind: "openai-compatible" as const, options_json: "{}" },
    ];
    const context = resolveCodexClientCatalogContext([
      { id: "all-true" },
      { id: "explicit-false" },
      { id: "unknown-mixed" },
      { id: "provider-metadata" },
      { id: "discovered-true" },
    ], providers, [
      { public_model: "all-true", provider_id: "codex", upstream_model: "upstream", route_options_json: JSON.stringify({ capabilities: { supports_search_tool: true } }) },
      { public_model: "all-true", provider_id: "openai-main", upstream_model: "other", route_options_json: JSON.stringify({ capabilities: { supports_search_tool: true } }) },
      { public_model: "explicit-false", provider_id: "codex", upstream_model: "upstream", route_options_json: JSON.stringify({ capabilities: { supports_search_tool: true } }) },
      { public_model: "explicit-false", provider_id: "openai-main", upstream_model: "other", route_options_json: JSON.stringify({ capabilities: { supports_search_tool: false } }) },
      { public_model: "unknown-mixed", provider_id: "codex", upstream_model: "upstream", route_options_json: JSON.stringify({ capabilities: { supports_search_tool: true } }) },
      { public_model: "unknown-mixed", provider_id: "openai-main", upstream_model: "other", route_options_json: "{}" },
      { public_model: "provider-metadata", provider_id: "codex", upstream_model: "upstream", route_options_json: "{}" },
      { public_model: "discovered-true", provider_id: "openai-main", upstream_model: "other", route_options_json: "{}", capabilities_json: JSON.stringify({ supports_search_tool: true }) },
    ]);
    expect(context.searchSupport.get("all-true")).toBe(true);
    expect(context.searchSupport.get("explicit-false")).toBe(false);
    expect(context.searchSupport.get("unknown-mixed")).toBe(false);
    expect(context.searchSupport.get("provider-metadata")).toBe(true);
    expect(context.searchSupport.get("discovered-true")).toBe(true);

    const [model] = buildCodexClientModels([{ id: "all-true", x_cflare_endpoints: ["responses"] }], context);
    expect(model?.supports_search_tool).toBe(true);
  });

  it("advertises multi-agent v2 only when every Responses route is enabled", () => {
    const context = resolveCodexClientCatalogContext([
      { id: "mixed-route", x_cflare_providers: ["codex", "openai-main"] },
      { id: "all-enabled", x_cflare_providers: ["codex", "openai-main"] },
      { id: "codex/direct", x_cflare_provider: "codex" },
    ], [
      { id: "codex", kind: "codex", options_json: JSON.stringify({ codex_multi_agent_v2: true }) },
      { id: "openai-main", kind: "openai-compatible", options_json: "{}" },
    ], [
      { public_model: "mixed-route", provider_id: "codex", route_options_json: JSON.stringify({ codex_multi_agent_v2: true }) },
      { public_model: "mixed-route", provider_id: "openai-main", route_options_json: "{}" },
      { public_model: "all-enabled", provider_id: "codex", route_options_json: "{}" },
      { public_model: "all-enabled", provider_id: "openai-main", route_options_json: JSON.stringify({ codex_multi_agent_v2: true }) },
    ]);
    expect([...context.multiAgentModels].sort()).toEqual(["all-enabled", "codex/direct"]);
  });
});
