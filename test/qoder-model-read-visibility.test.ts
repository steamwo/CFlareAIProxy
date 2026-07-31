import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  gatewayKeyAllowsModel,
  listModels,
  listRoutesForModel,
} from "../src/db";
import { listDiscoveredModels } from "../src/models";
import type { Env } from "../src/types";

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly bindings: unknown[] = [],
  ) {}

  bind(...bindings: unknown[]): SqliteD1Statement {
    return new SqliteD1Statement(this.database, this.sql, bindings);
  }

  async all<T>(): Promise<D1Result<T>> {
    const results = this.database.prepare(this.sql).all(...this.bindings) as T[];
    return { results, success: true, meta: {} } as D1Result<T>;
  }

  async first<T>(columnName?: string): Promise<T | null> {
    const row = this.database.prepare(this.sql).get(...this.bindings) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (columnName ? row[columnName] : row) as T;
  }

  async run(): Promise<D1Result<unknown>> {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return {
      results: [],
      success: true,
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result<unknown>;
  }
}

class SqliteD1Database {
  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string): D1PreparedStatement {
    return new SqliteD1Statement(this.database, sql) as unknown as D1PreparedStatement;
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return Promise.all(statements.map((statement) => statement.run<T>()));
  }
}

function createEnvironment(database: DatabaseSync): Env {
  const cache = {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
  };
  return {
    DB: new SqliteD1Database(database),
    CONFIG_CACHE: cache,
  } as unknown as Env;
}

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      options_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE credentials (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      label TEXT NOT NULL,
      enabled INTEGER NOT NULL
    );
    CREATE TABLE discovered_models (
      provider_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      owned_by TEXT NOT NULL DEFAULT '',
      capabilities_json TEXT NOT NULL DEFAULT '{}',
      raw_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      discovered_at INTEGER NOT NULL
    );
    CREATE TABLE model_routes (
      id TEXT PRIMARY KEY,
      public_model TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      upstream_model TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      priority INTEGER NOT NULL,
      weight INTEGER NOT NULL,
      options_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    INSERT INTO providers(id,name,kind,enabled,options_json)
    VALUES('qoder','Qoder','qoder',1,'{}'),('codex','Codex','codex',1,'{}');
    INSERT INTO credentials(id,provider_id,label,enabled)
    VALUES('qoder-disabled','qoder','disabled Qoder',0);
    INSERT INTO discovered_models(
      provider_id,credential_id,model_id,display_name,endpoint,owned_by,enabled,discovered_at
    ) VALUES
      ('qoder','','qoder-upstream','Qoder Public','chat','qoder',1,100),
      ('qoder','qoder-disabled','qoder-upstream','Qoder Public','chat','qoder',1,100),
      ('codex','','codex-model','Codex Model','responses','codex',1,100);
    INSERT INTO model_routes(
      id,public_model,provider_id,upstream_model,endpoint,enabled,priority,weight,created_at,updated_at
    ) VALUES(
      'qoder-configured','qoder-route','qoder','qoder-upstream','chat',1,10,1,100,100
    );
  `);
  return database;
}

let database: DatabaseSync | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("Qoder model read visibility", () => {
  it("hides stale discovery and route rows until an enabled Qoder account exists", async () => {
    database = createDatabase();
    const env = createEnvironment(database);

    const unavailableAdminModels = await listDiscoveredModels(env);
    expect(unavailableAdminModels.map((model) => model.provider_id)).toEqual(["codex"]);

    const unavailablePublicModels = await listModels(env);
    expect(unavailablePublicModels.map((model) => model.id)).toEqual(["codex/codex-model"]);
    expect(await listRoutesForModel(env, "Qoder Public", "chat")).toEqual([]);
    expect(await listRoutesForModel(env, "qoder-route", "chat")).toEqual([]);
    expect(await gatewayKeyAllowsModel(
      env,
      "Qoder Public",
      ["qoder/qoder-upstream"],
    )).toBe(false);

    database.prepare("UPDATE credentials SET enabled=1 WHERE id='qoder-disabled'").run();

    const availableAdminModels = await listDiscoveredModels(env);
    expect(availableAdminModels.filter((model) => model.provider_id === "qoder")).toHaveLength(2);

    const availablePublicModels = await listModels(env);
    expect(availablePublicModels.map((model) => model.id)).toEqual([
      "codex/codex-model",
      "Qoder Public",
      "qoder-route",
    ]);
    expect(await listRoutesForModel(env, "Qoder Public", "chat")).toHaveLength(1);
    expect(await listRoutesForModel(env, "qoder-route", "chat")).toHaveLength(1);
    expect(await gatewayKeyAllowsModel(
      env,
      "Qoder Public",
      ["qoder/qoder-upstream"],
    )).toBe(true);
  });
});
