import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/20260731_qoder_shared_model_cleanup.sql", import.meta.url),
  "utf8",
);

let database: DatabaseSync | undefined;

function createDatabase(seedSql = ""): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE credentials (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      enabled INTEGER NOT NULL
    );
    CREATE TABLE discovered_models (
      provider_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      model_id TEXT NOT NULL
    );
    ${seedSql}
    ${migration}
  `);
  return db;
}

function insertSharedModel(db: DatabaseSync, modelId = "anonymous-model"): void {
  db.prepare(
    "INSERT INTO discovered_models(provider_id,credential_id,model_id) VALUES('qoder','',?)",
  ).run(modelId);
}

function sharedModelCount(db: DatabaseSync): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM discovered_models WHERE provider_id='qoder' AND credential_id=''",
  ).get() as { count: number };
  return Number(row.count);
}

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("Qoder shared model cleanup migration", () => {
  it("removes an existing shared snapshot when no enabled Qoder account exists", () => {
    database = createDatabase(`
      INSERT INTO credentials(id,provider_id,enabled) VALUES('disabled-qoder','qoder',0);
      INSERT INTO discovered_models(provider_id,credential_id,model_id) VALUES('qoder','','stale-model');
      INSERT INTO discovered_models(provider_id,credential_id,model_id) VALUES('qoder','disabled-qoder','account-model');
      INSERT INTO discovered_models(provider_id,credential_id,model_id) VALUES('codex','','codex-model');
    `);

    expect(sharedModelCount(database)).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM discovered_models").get())
      .toEqual({ count: 2 });
  });

  it("preserves an existing shared snapshot while an enabled Qoder account exists", () => {
    database = createDatabase(`
      INSERT INTO credentials(id,provider_id,enabled) VALUES('qoder-a','qoder',1);
      INSERT INTO discovered_models(provider_id,credential_id,model_id) VALUES('qoder','','live-model');
    `);

    expect(sharedModelCount(database)).toBe(1);
  });

  it("removes the shared snapshot after the last enabled Qoder account is deleted", () => {
    database = createDatabase(`
      INSERT INTO credentials(id,provider_id,enabled) VALUES('qoder-a','qoder',1);
      INSERT INTO credentials(id,provider_id,enabled) VALUES('qoder-b','qoder',1);
    `);
    insertSharedModel(database);

    database.prepare("DELETE FROM credentials WHERE id='qoder-a'").run();
    expect(sharedModelCount(database)).toBe(1);

    database.prepare("DELETE FROM credentials WHERE id='qoder-b'").run();
    expect(sharedModelCount(database)).toBe(0);
  });

  it("removes the shared snapshot after the last enabled Qoder account is disabled", () => {
    database = createDatabase(`
      INSERT INTO credentials(id,provider_id,enabled) VALUES('qoder-a','qoder',1);
    `);
    insertSharedModel(database);

    database.prepare("UPDATE credentials SET enabled=0 WHERE id='qoder-a'").run();
    expect(sharedModelCount(database)).toBe(0);
  });

  it("removes the shared snapshot when the last enabled account leaves Qoder", () => {
    database = createDatabase(`
      INSERT INTO credentials(id,provider_id,enabled) VALUES('qoder-a','qoder',1);
    `);
    insertSharedModel(database);

    database.prepare("UPDATE credentials SET provider_id='codex' WHERE id='qoder-a'").run();
    expect(sharedModelCount(database)).toBe(0);
  });
});
