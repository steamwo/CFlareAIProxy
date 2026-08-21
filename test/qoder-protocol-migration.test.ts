import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/20260815_qoder_protocol_endpoints.sql", import.meta.url),
  "utf8",
);

let database: DatabaseSync | undefined;

function createDatabase(seedBeforeMigration = false): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE discovered_models (
      provider_id TEXT NOT NULL,
      credential_id TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      endpoint TEXT NOT NULL DEFAULT 'chat',
      owned_by TEXT NOT NULL DEFAULT '',
      capabilities_json TEXT NOT NULL DEFAULT '{}',
      raw_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      discovered_at INTEGER NOT NULL,
      PRIMARY KEY(provider_id, credential_id, model_id, endpoint)
    );
  `);
  if (seedBeforeMigration) insertQoder(db, "before");
  db.exec(migration);
  return db;
}

function rawModel(disabled: unknown = {}): string {
  return JSON.stringify({
    is_vl: true,
    max_input_tokens: 131072,
    context_config: {
      standard: { token_count: 65536, is_default: true },
      large: { token_count: 131072 },
    },
    thinking_config: {
      enabled: { efforts: { low: {}, high: {} } },
      disabled,
    },
  });
}

function insertQoder(db: DatabaseSync, id: string, disabled: unknown = {}): void {
  db.prepare(`
    INSERT INTO discovered_models(
      provider_id,credential_id,model_id,display_name,endpoint,owned_by,
      capabilities_json,raw_json,enabled,discovered_at
    ) VALUES('qoder','credential-1',?,?, 'chat','qoder','{}',?,1,1)
  `).run(id, `Qoder ${id}`, rawModel(disabled));
}

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("Qoder protocol endpoint migration", () => {
  it("backfills Responses and Messages rows and normalizes live protocol capabilities", () => {
    database = createDatabase(true);
    const rows = database.prepare(
      "SELECT endpoint,capabilities_json FROM discovered_models WHERE model_id='before' ORDER BY endpoint",
    ).all() as Array<{ endpoint: string; capabilities_json: string }>;
    expect(rows.map((row) => row.endpoint)).toEqual(["chat", "messages", "responses"]);
    for (const row of rows) {
      const capabilities = JSON.parse(row.capabilities_json) as Record<string, unknown>;
      expect(capabilities.contextWindow).toBe(131072);
      expect(capabilities.supportsTools).toBe(true);
      expect(capabilities.supportsImages).toBe(false);
      expect(capabilities.inputModalities).toEqual(["text"]);
      expect(capabilities.reasoningLevels).toEqual(expect.arrayContaining(["low", "high", "none"]));
    }
  });

  it("does not advertise reasoning=none when Qoder reports disabled as null", () => {
    database = createDatabase();
    insertQoder(database, "no-disable", null);
    const row = database.prepare(
      "SELECT capabilities_json FROM discovered_models WHERE provider_id='qoder' AND model_id='no-disable' AND endpoint='chat'",
    ).get() as { capabilities_json: string };
    const capabilities = JSON.parse(row.capabilities_json) as { reasoningLevels?: string[] };
    expect(capabilities.reasoningLevels).toEqual(expect.arrayContaining(["low", "high"]));
    expect(capabilities.reasoningLevels).not.toContain("none");
  });

  it("mirrors future Qoder chat discoveries without touching non-Qoder rows", () => {
    database = createDatabase();
    insertQoder(database, "after");
    database.prepare(`
      INSERT INTO discovered_models(
        provider_id,credential_id,model_id,display_name,endpoint,owned_by,
        capabilities_json,raw_json,enabled,discovered_at
      ) VALUES('other','credential-1','model','Other','chat','other','{}','{}',1,1)
    `).run();
    const qoderEndpoints = database.prepare(
      "SELECT endpoint FROM discovered_models WHERE provider_id='qoder' AND model_id='after' ORDER BY endpoint",
    ).all() as Array<{ endpoint: string }>;
    const otherEndpoints = database.prepare(
      "SELECT endpoint FROM discovered_models WHERE provider_id='other' ORDER BY endpoint",
    ).all() as Array<{ endpoint: string }>;
    expect(qoderEndpoints.map((row) => row.endpoint)).toEqual(["chat", "messages", "responses"]);
    expect(otherEndpoints.map((row) => row.endpoint)).toEqual(["chat"]);
  });
});
