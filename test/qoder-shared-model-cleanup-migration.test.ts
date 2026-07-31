import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const identityMigration = readFileSync(
  new URL("../migrations/20260731_stale_model_discovery_cleanup.sql", import.meta.url),
  "utf8",
);
const sharedMigration = readFileSync(
  new URL("../migrations/20260731_qoder_shared_model_cleanup.sql", import.meta.url),
  "utf8",
);
const disabledAccountMigration = readFileSync(
  new URL("../migrations/20260732_qoder_disabled_account_model_cleanup.sql", import.meta.url),
  "utf8",
);

let database: DatabaseSync | undefined;

function createDatabase(seedSql = ""): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE providers (
      id TEXT PRIMARY KEY,
      base_url TEXT NOT NULL DEFAULT '',
      endpoints_json TEXT NOT NULL DEFAULT '{}',
      options_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE credentials (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      auth_type TEXT NOT NULL DEFAULT 'oauth',
      secret_ciphertext TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL
    );
    CREATE TABLE discovered_models (
      provider_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      model_id TEXT NOT NULL
    );
    ${seedSql}
    ${identityMigration}
    ${sharedMigration}
    ${disabledAccountMigration}
  `);
  return db;
}

function insertSharedModel(db: DatabaseSync, modelId = "anonymous-model"): void {
  db.prepare(
    "INSERT INTO discovered_models(provider_id,credential_id,model_id) VALUES('qoder','',?)",
  ).run(modelId);
}

function insertAccountModel(db: DatabaseSync, credentialId: string, modelId = `${credentialId}-model`): void {
  db.prepare(
    "INSERT INTO discovered_models(provider_id,credential_id,model_id) VALUES('qoder',?,?)",
  ).run(credentialId, modelId);
}

function discoveredCount(db: DatabaseSync, credentialId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM discovered_models WHERE provider_id='qoder' AND credential_id=?",
  ).get(credentialId) as { count: number };
  return Number(row.count);
}

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("Qoder model cleanup migrations", () => {
  it("repairs shared, disabled-account, and orphaned Qoder snapshots", () => {
    database = createDatabase(`
      INSERT INTO credentials(id,provider_id,enabled) VALUES('disabled-qoder','qoder',0);
      INSERT INTO discovered_models(provider_id,credential_id,model_id) VALUES('qoder','','stale-model');
      INSERT INTO discovered_models(provider_id,credential_id,model_id) VALUES('qoder','disabled-qoder','disabled-model');
      INSERT INTO discovered_models(provider_id,credential_id,model_id) VALUES('qoder','missing-qoder','orphan-model');
      INSERT INTO discovered_models(provider_id,credential_id,model_id) VALUES('codex','','codex-model');
    `);

    expect(discoveredCount(database, "")).toBe(0);
    expect(discoveredCount(database, "disabled-qoder")).toBe(0);
    expect(discoveredCount(database, "missing-qoder")).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM discovered_models").get())
      .toEqual({ count: 1 });
  });

  it("preserves shared and account snapshots for an enabled Qoder account", () => {
    database = createDatabase(`
      INSERT INTO credentials(id,provider_id,enabled) VALUES('qoder-a','qoder',1);
      INSERT INTO discovered_models(provider_id,credential_id,model_id) VALUES('qoder','','live-model');
      INSERT INTO discovered_models(provider_id,credential_id,model_id) VALUES('qoder','qoder-a','account-model');
    `);

    expect(discoveredCount(database, "")).toBe(1);
    expect(discoveredCount(database, "qoder-a")).toBe(1);
  });

  it("removes account snapshots and then the shared snapshot as enabled accounts are deleted", () => {
    database = createDatabase(`
      INSERT INTO credentials(id,provider_id,enabled) VALUES('qoder-a','qoder',1);
      INSERT INTO credentials(id,provider_id,enabled) VALUES('qoder-b','qoder',1);
    `);
    insertSharedModel(database);
    insertAccountModel(database, "qoder-a");
    insertAccountModel(database, "qoder-b");

    database.prepare("DELETE FROM credentials WHERE id='qoder-a'").run();
    expect(discoveredCount(database, "qoder-a")).toBe(0);
    expect(discoveredCount(database, "qoder-b")).toBe(1);
    expect(discoveredCount(database, "")).toBe(1);

    database.prepare("DELETE FROM credentials WHERE id='qoder-b'").run();
    expect(discoveredCount(database, "qoder-b")).toBe(0);
    expect(discoveredCount(database, "")).toBe(0);
  });

  it("removes the disabled account snapshot without hiding models backed by another enabled account", () => {
    database = createDatabase(`
      INSERT INTO credentials(id,provider_id,enabled) VALUES('qoder-a','qoder',1);
      INSERT INTO credentials(id,provider_id,enabled) VALUES('qoder-b','qoder',1);
    `);
    insertSharedModel(database);
    insertAccountModel(database, "qoder-a");
    insertAccountModel(database, "qoder-b");

    database.prepare("UPDATE credentials SET enabled=0 WHERE id='qoder-a'").run();
    expect(discoveredCount(database, "qoder-a")).toBe(0);
    expect(discoveredCount(database, "qoder-b")).toBe(1);
    expect(discoveredCount(database, "")).toBe(1);
  });

  it("removes both account and shared snapshots after the last account is disabled", () => {
    database = createDatabase(`
      INSERT INTO credentials(id,provider_id,enabled) VALUES('qoder-a','qoder',1);
    `);
    insertSharedModel(database);
    insertAccountModel(database, "qoder-a");

    database.prepare("UPDATE credentials SET enabled=0 WHERE id='qoder-a'").run();
    expect(discoveredCount(database, "qoder-a")).toBe(0);
    expect(discoveredCount(database, "")).toBe(0);
  });

  it("removes both account and shared snapshots when the last enabled account leaves Qoder", () => {
    database = createDatabase(`
      INSERT INTO credentials(id,provider_id,enabled) VALUES('qoder-a','qoder',1);
    `);
    insertSharedModel(database);
    insertAccountModel(database, "qoder-a");

    database.prepare("UPDATE credentials SET provider_id='codex' WHERE id='qoder-a'").run();
    expect(discoveredCount(database, "qoder-a")).toBe(0);
    expect(discoveredCount(database, "")).toBe(0);
  });
});
