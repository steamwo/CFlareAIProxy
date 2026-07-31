import { describe, expect, it } from "vitest";
import { gatewayKeyAllowsModel, listRoutesForModel, normalizeGatewayAllowedModelLists, normalizeGatewayAllowedModels } from "../src/db";
import {
  discoveredModelAllowed,
  discoveryCredentialScopes,
  normalizeAllowedModelNames,
  publicDiscoveredModelId,
  sortModelRoutes,
} from "../src/qoder-model-routing";
import type { Env, GatewayEndpoint, ModelRouteRow } from "../src/types";

interface QueryResult {
  all?: unknown[];
  first?: unknown;
}

class FakeStatement {
  private values: unknown[] = [];

  constructor(private readonly db: FakeDatabase, private readonly sql: string) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async all<T>(): Promise<D1Result<T>> {
    const result = this.db.resolve(this.sql, this.values);
    return { results: (result.all ?? []) as T[], success: true, meta: {} } as D1Result<T>;
  }

  async first<T>(): Promise<T | null> {
    return (this.db.resolve(this.sql, this.values).first ?? null) as T | null;
  }
}

class FakeDatabase {
  constructor(private readonly handler: (sql: string, values: unknown[]) => QueryResult) {}

  prepare(sql: string): D1PreparedStatement {
    return new FakeStatement(this, sql) as unknown as D1PreparedStatement;
  }

  resolve(sql: string, values: unknown[]): QueryResult {
    return this.handler(sql, values);
  }
}

function envWithDatabase(db: FakeDatabase): Env {
  return { DB: db as unknown as D1Database } as Env;
}

function route(providerId: string, priority: number, weight: number, upstreamModel = `${providerId}-model`): ModelRouteRow {
  return {
    id: `${providerId}-route`, public_model: "Claude Sonnet", provider_id: providerId,
    upstream_model: upstreamModel, endpoint: "chat", enabled: 1, priority, weight,
    options_json: "{}", created_at: priority, updated_at: priority,
  };
}

describe("Qoder channel model routing", () => {
  it("stores Qoder discovery in account and channel scopes only", () => {
    expect(discoveryCredentialScopes("qoder", "credential-a")).toEqual(["credential-a", ""]);
    expect(discoveryCredentialScopes("codex", "credential-a")).toEqual(["credential-a"]);
  });

  it("uses display_name as Qoder's public model id", () => {
    expect(publicDiscoveredModelId("qoder", "qoder", "anon-a8f3", "Claude Sonnet")).toBe("Claude Sonnet");
    expect(publicDiscoveredModelId("qoder", "qoder", "anon-a8f3", "  ")).toBe("anon-a8f3");
    expect(publicDiscoveredModelId("codex", "codex", "gpt-5", "GPT-5")).toBe("codex/gpt-5");
  });

  it("keeps legacy anonymous Qoder allow-list entries compatible without exposing them", () => {
    const model = { id: "Claude Sonnet", x_cflare_provider: "qoder", x_cflare_upstream_model: "anon-a8f3" };
    expect(discoveredModelAllowed(model, new Set(["Claude Sonnet"]))).toBe(true);
    expect(discoveredModelAllowed(model, new Set(["qoder/anon-a8f3"]))).toBe(true);
    expect(discoveredModelAllowed(model, new Set(["qoder/another-model"]))).toBe(false);
  });

  it("normalizes legacy Qoder model restrictions and removes duplicates", () => {
    const aliases = new Map([["anon-a8f3", "Claude Sonnet"]]);
    expect(normalizeAllowedModelNames(
      [" qoder/anon-a8f3 ", "Claude Sonnet", "codex/gpt-5", "", "qoder/unknown"],
      aliases,
    )).toEqual(["Claude Sonnet", "codex/gpt-5", "qoder/unknown"]);
  });

  it("normalizes multiple gateway-key model lists with one channel lookup", async () => {
    let queries = 0;
    const db = new FakeDatabase((sql) => {
      queries += 1;
      expect(sql).toContain("credential_id='' AND enabled=1");
      return { all: [
        { model_id: "anon-a8f3", display_name: "Claude Sonnet", discovered_at: 20 },
        { model_id: "anon-a8f3", display_name: "Old Name", discovered_at: 10 },
      ] };
    });
    const env = envWithDatabase(db);
    await expect(normalizeGatewayAllowedModelLists(env, [
      ["qoder/anon-a8f3", "codex/gpt-5"],
      ["qoder/anon-a8f3", "Claude Sonnet"],
    ])).resolves.toEqual([
      ["Claude Sonnet", "codex/gpt-5"],
      ["Claude Sonnet"],
    ]);
    expect(queries).toBe(1);
    await expect(normalizeGatewayAllowedModels(env, ["codex/gpt-5"])).resolves.toEqual(["codex/gpt-5"]);
    expect(queries).toBe(1);
  });

  it("sorts automatic Qoder routes together with explicit provider routes", () => {
    expect(sortModelRoutes([route("secondary", 200, 1), route("qoder", 100, 1), route("primary", 100, 5)])
      .map((item) => item.provider_id)).toEqual(["primary", "qoder", "secondary"]);
  });

  it("adds Qoder as a candidate for the same public model name", async () => {
    const explicit = route("openai-provider", 100, 5, "claude-sonnet-4");
    const db = new FakeDatabase((sql, values) => {
      if (sql.includes("FROM model_routes")) return { all: [explicit] };
      if (sql.includes("dm.provider_id='qoder'")) {
        expect(values).toEqual(["Claude Sonnet", "chat"]);
        return { all: [{ model_id: "anon-a8f3", created_at: 20, options_json: '{"routing_weight":3}' }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const routes = await listRoutesForModel(envWithDatabase(db), "Claude Sonnet", "chat" as GatewayEndpoint);
    expect(routes.map((item) => [item.provider_id, item.upstream_model, item.weight])).toEqual([
      ["openai-provider", "claude-sonnet-4", 5],
      ["qoder", "anon-a8f3", 3],
    ]);
  });

  it("lets an explicit Qoder route override the automatic channel mapping", async () => {
    const explicit = route("qoder", 10, 1, "manual-anon-model");
    const db = new FakeDatabase((sql) => {
      if (sql.includes("FROM model_routes")) return { all: [explicit] };
      throw new Error(`Automatic discovery should not run: ${sql}`);
    });
    const routes = await listRoutesForModel(envWithDatabase(db), "Claude Sonnet", "chat");
    expect(routes).toEqual([explicit]);
  });

  it("authorizes a display name through a legacy Qoder anonymous allow-list entry", async () => {
    const db = new FakeDatabase((sql, values) => {
      expect(sql).toContain("credential_id='' AND display_name=?");
      expect(values).toEqual(["Claude Sonnet"]);
      return { all: [{ model_id: "anon-a8f3" }] };
    });
    const env = envWithDatabase(db);
    await expect(gatewayKeyAllowsModel(env, "Claude Sonnet", ["qoder/anon-a8f3"])).resolves.toBe(true);
    await expect(gatewayKeyAllowsModel(env, "Claude Sonnet", ["qoder/other"])).resolves.toBe(false);
    await expect(gatewayKeyAllowsModel(env, "Claude Sonnet", ["Claude Sonnet"])).resolves.toBe(true);
  });
});
