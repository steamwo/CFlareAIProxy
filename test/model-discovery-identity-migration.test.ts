import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/20260731_stale_model_discovery_cleanup.sql", import.meta.url),
  "utf8",
);

let database: DatabaseSync | undefined;

function createDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE providers (
      id TEXT PRIMARY KEY,
      base_url TEXT NOT NULL,
      endpoints_json TEXT NOT NULL,
      options_json TEXT NOT NULL
    );
    CREATE TABLE credentials (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      auth_type TEXT NOT NULL,
      secret_ciphertext TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
    CREATE TABLE discovered_models (
      provider_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      model_id TEXT NOT NULL
    );
    ${migration}
  `);
  return db;
}

function seed(db: DatabaseSync, authType = "api_key"): void {
  db.prepare(
    "INSERT INTO providers(id,base_url,endpoints_json,options_json) VALUES(?,?,?,?)",
  ).run("provider-1", "https://old.example/v1", '{"responses":"/responses"}', "{}");
  db.prepare(
    "INSERT INTO credentials(id,provider_id,auth_type,secret_ciphertext,metadata_json) VALUES(?,?,?,?,?)",
  ).run("credential-1", "provider-1", authType, "secret-a", '{"account_id":"one"}');
  db.prepare(
    "INSERT INTO discovered_models(provider_id,credential_id,model_id) VALUES(?,?,?)",
  ).run("provider-1", "credential-1", "model-a");
}

function discoveryCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM discovered_models").get() as { count: number };
  return Number(row.count);
}

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("stale model discovery identity migration", () => {
  it("removes API-key discovery before a rotated secret can be refreshed", () => {
    database = createDatabase();
    seed(database);
    database.prepare("UPDATE credentials SET secret_ciphertext=? WHERE id=?")
      .run("secret-b", "credential-1");
    expect(discoveryCount(database)).toBe(0);
  });

  it("does not remove discovery during routine OAuth access-token refresh", () => {
    database = createDatabase();
    seed(database, "oauth");
    database.prepare("UPDATE credentials SET secret_ciphertext=? WHERE id=?")
      .run("access-token-b", "credential-1");
    expect(discoveryCount(database)).toBe(1);
  });

  it("removes discovery when credential identity metadata or ownership changes", () => {
    database = createDatabase();
    seed(database);
    database.prepare("UPDATE credentials SET metadata_json=? WHERE id=?")
      .run('{"account_id":"two"}', "credential-1");
    expect(discoveryCount(database)).toBe(0);

    database.prepare(
      "INSERT INTO discovered_models(provider_id,credential_id,model_id) VALUES(?,?,?)",
    ).run("provider-1", "credential-1", "model-b");
    database.prepare("UPDATE credentials SET provider_id=? WHERE id=?")
      .run("provider-2", "credential-1");
    expect(discoveryCount(database)).toBe(0);
  });

  it("removes provider discovery when the model endpoint identity changes", () => {
    database = createDatabase();
    seed(database);
    database.prepare("UPDATE providers SET base_url=? WHERE id=?")
      .run("https://new.example/v1", "provider-1");
    expect(discoveryCount(database)).toBe(0);

    database.prepare(
      "INSERT INTO discovered_models(provider_id,credential_id,model_id) VALUES(?,?,?)",
    ).run("provider-1", "credential-1", "model-b");
    database.prepare("UPDATE providers SET endpoints_json=? WHERE id=?")
      .run('{"chat":"/chat/completions"}', "provider-1");
    expect(discoveryCount(database)).toBe(0);
  });

  it("preserves discovery for unrelated provider option changes", () => {
    database = createDatabase();
    seed(database);
    database.prepare("UPDATE providers SET options_json=? WHERE id=?")
      .run('{"routing_weight":5}', "provider-1");
    expect(discoveryCount(database)).toBe(1);
  });

  it("removes discovery when a credential or provider is deleted outside the admin API", () => {
    database = createDatabase();
    seed(database);
    database.prepare("DELETE FROM credentials WHERE id=?").run("credential-1");
    expect(discoveryCount(database)).toBe(0);

    database.prepare(
      "INSERT INTO discovered_models(provider_id,credential_id,model_id) VALUES(?,?,?)",
    ).run("provider-1", "orphan", "model-b");
    database.prepare("DELETE FROM providers WHERE id=?").run("provider-1");
    expect(discoveryCount(database)).toBe(0);
  });
});
