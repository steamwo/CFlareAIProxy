import { describe, expect, it } from "vitest";
import {
  availabilityDetail, buildDisplayRows, buildRouteGroups, combinedStatus, endpointLabel,
  formatRetry, managed, multiAgentEnabled, parseOptions, retryAt, sortEndpoint, statusMeta, statusRank,
} from "./route-display";
import type { ModelRoute } from "../types";

const MANAGED = JSON.stringify({ managed_by: "provider-model-selection" });

function route(overrides: Partial<ModelRoute> = {}): ModelRoute {
  return {
    id: "route-1",
    public_model: "coding-fast",
    provider_id: "openai-main",
    upstream_model: "gpt-5",
    endpoint: "chat",
    enabled: 1,
    priority: 100,
    weight: 1,
    options_json: "{}",
    ...overrides,
  };
}

describe("sortEndpoint", () => {
  it("orders known protocols then falls back to alphabetical", () => {
    expect(["completions", "chat", "responses"].sort(sortEndpoint)).toEqual(["responses", "chat", "completions"]);
    expect(["zeta", "alpha"].sort(sortEndpoint)).toEqual(["alpha", "zeta"]);
  });
});

describe("parseOptions / managed / multiAgentEnabled", () => {
  it("returns an empty object for blank or malformed JSON", () => {
    expect(parseOptions(route({ options_json: "" }))).toEqual({});
    expect(parseOptions(route({ options_json: "{oops" }))).toEqual({});
  });

  it("detects provider-managed routes", () => {
    expect(managed(route({ options_json: MANAGED }))).toBe(true);
    expect(managed(route())).toBe(false);
  });

  it("accepts both the snake_case and camelCase multi-agent flags", () => {
    expect(multiAgentEnabled(route({ options_json: JSON.stringify({ codex_multi_agent_v2: true }) }))).toBe(true);
    expect(multiAgentEnabled(route({ options_json: JSON.stringify({ codexMultiAgentV2: true }) }))).toBe(true);
    expect(multiAgentEnabled(route())).toBe(false);
  });
});

describe("buildDisplayRows", () => {
  it("collapses managed rows that differ only by endpoint", () => {
    const rows = buildDisplayRows([
      route({ id: "a", endpoint: "chat", options_json: MANAGED }),
      route({ id: "b", endpoint: "responses", options_json: MANAGED }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.endpoints).toEqual(["responses", "chat"]);
    expect(rows[0]?.routeIds).toEqual(["a", "b"]);
  });

  it("keeps hand-managed rows separate even when otherwise identical", () => {
    const rows = buildDisplayRows([
      route({ id: "a", endpoint: "chat" }),
      route({ id: "b", endpoint: "responses" }),
    ]);

    expect(rows).toHaveLength(2);
  });

  it("does not merge managed rows that differ in scheduling policy", () => {
    const rows = buildDisplayRows([
      route({ id: "a", endpoint: "chat", priority: 100, options_json: MANAGED }),
      route({ id: "b", endpoint: "responses", priority: 200, options_json: MANAGED }),
    ]);

    expect(rows).toHaveLength(2);
  });

  it("sorts the grouped endpoint states alongside the endpoints", () => {
    const rows = buildDisplayRows([
      route({ id: "a", endpoint: "completions", options_json: MANAGED, availability: { status: "ready", availableCredentials: 2, totalCredentials: 2 } }),
      route({ id: "b", endpoint: "responses", options_json: MANAGED, availability: { status: "degraded", availableCredentials: 1, totalCredentials: 2 } }),
    ]);

    expect(rows[0]?.endpointStates.map((item) => item.endpoint)).toEqual(["responses", "completions"]);
  });
});

describe("buildRouteGroups", () => {
  const label = (id: string) => (id === "openai-main" ? "OpenAI 主线路" : id);

  it("groups by public model and sorts by priority then weight", () => {
    const rows = buildDisplayRows([
      route({ id: "a", public_model: "beta", priority: 100, weight: 1 }),
      route({ id: "b", public_model: "alpha", priority: 200, weight: 5 }),
      route({ id: "c", public_model: "alpha", priority: 100, weight: 1 }),
      route({ id: "d", public_model: "alpha", priority: 200, weight: 9 }),
    ]);

    const groups = buildRouteGroups(rows, "", label);

    expect(groups.map((group) => group.publicModel)).toEqual(["alpha", "beta"]);
    expect(groups[0]?.routes.map((item) => item.id)).toEqual(["c", "d", "b"]);
  });

  it("filters on model, provider id, source label and upstream model", () => {
    const rows = buildDisplayRows([
      route({ id: "a", public_model: "alpha", provider_id: "openai-main", upstream_model: "gpt-5" }),
      route({ id: "b", public_model: "beta", provider_id: "kimi", upstream_model: "moonshot-v1" }),
    ]);

    expect(buildRouteGroups(rows, "主线路", label).map((group) => group.publicModel)).toEqual(["alpha"]);
    expect(buildRouteGroups(rows, "MOONSHOT", label).map((group) => group.publicModel)).toEqual(["beta"]);
    expect(buildRouteGroups(rows, "  ", label)).toHaveLength(2);
    expect(buildRouteGroups(rows, "nothing", label)).toHaveLength(0);
  });
});

describe("route status derivation", () => {
  const display = (...states: Array<ModelRoute["availability"]>) =>
    buildDisplayRows(states.map((availability, index) =>
      route({ id: `r${index}`, endpoint: index === 0 ? "chat" : "responses", options_json: MANAGED, availability })))[0];

  it("ranks statuses worst-first", () => {
    expect(statusRank("unavailable")).toBe(2);
    expect(statusRank("degraded")).toBe(1);
    expect(statusRank("ready")).toBe(0);
    expect(statusRank(undefined)).toBe(0);
  });

  it("reports the worst endpoint status for a grouped route", () => {
    const ready = display({ status: "ready", availableCredentials: 2, totalCredentials: 2 });
    const mixed = display(
      { status: "ready", availableCredentials: 2, totalCredentials: 2 },
      { status: "unavailable", availableCredentials: 0, totalCredentials: 2 },
    );

    expect(ready && combinedStatus(ready)).toBe("ready");
    expect(mixed && combinedStatus(mixed)).toBe("unavailable");
    expect(mixed && statusMeta(mixed)).toEqual({ type: "error", label: "已摘除" });
    expect(ready && statusMeta(ready)).toEqual({ type: "success", label: "可用" });
  });

  it("explains failures by endpoint and healthy routes by account headroom", () => {
    const broken = display(
      { status: "ready", availableCredentials: 2, totalCredentials: 3 },
      { status: "degraded", availableCredentials: 1, totalCredentials: 3, reason: "上游超时" },
    );
    expect(broken && availabilityDetail(broken)).toBe("Responses：上游超时");

    const healthy = display(
      { status: "ready", availableCredentials: 1, totalCredentials: 3 },
      { status: "ready", availableCredentials: 2, totalCredentials: 3 },
    );
    expect(healthy && availabilityDetail(healthy)).toBe("1/3 个账号可用");
  });

  it("falls back to a waiting message with no availability data", () => {
    const unknown = display(undefined);
    expect(unknown && availabilityDetail(unknown)).toBe("等待运行数据");
  });

  it("uses a default reason when a failing endpoint reports none", () => {
    const broken = display({ status: "unavailable", availableCredentials: 0, totalCredentials: 1 });
    expect(broken && availabilityDetail(broken)).toBe("Chat Completions：不可用");
  });

  it("returns the latest retry deadline, or 0 when none is pending", () => {
    const pending = display(
      { status: "unavailable", availableCredentials: 0, totalCredentials: 1, retryAt: 1_700_000_000 },
      { status: "unavailable", availableCredentials: 0, totalCredentials: 1, retryAt: 1_700_000_500 },
    );
    expect(pending && retryAt(pending)).toBe(1_700_000_500);

    const idle = display({ status: "ready", availableCredentials: 1, totalCredentials: 1 });
    expect(idle && retryAt(idle)).toBe(0);
  });
});

describe("labels", () => {
  it("maps known endpoints and passes unknown ones through", () => {
    expect(endpointLabel("responses")).toBe("Responses");
    expect(endpointLabel("custom")).toBe("custom");
  });

  it("renders a retry timestamp only when one exists", () => {
    expect(formatRetry(0)).toBe("");
    expect(formatRetry(undefined)).toBe("");
    expect(formatRetry(1_700_000_000)).not.toBe("");
  });
});
