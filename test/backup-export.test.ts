import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminApp } from "../src/admin";
import type { Env } from "../src/types";

/**
 * A fake D1 that answers the export SELECTs from a table fixture and records every
 * statement a batch would have run. It deliberately does not execute SQL: the properties
 * under test are which statements are produced, and that a failing batch leaves nothing
 * behind — not SQLite's own upsert semantics.
 */
interface RecordedStatement {
  sql: string;
  args: unknown[];
}

interface FakeDb {
  db: D1Database;
  batches: RecordedStatement[][];
  ran: RecordedStatement[];
  failBatch: (message: string | null) => void;
}

function createFakeDb(fixture: Record<string, Record<string, unknown>[]>): FakeDb {
  const batches: RecordedStatement[][] = [];
  const ran: RecordedStatement[] = [];
  let batchFailure: string | null = null;

  const prepare = (sql: string) => {
    const statement = {
      sql,
      args: [] as unknown[],
      bind(...args: unknown[]) {
        this.args = args;
        return this;
      },
      async all() {
        const table = sql.match(/FROM "(\w+)"/)?.[1] ?? "";
        return { results: fixture[table] ?? [], success: true, meta: {} };
      },
      async first() { return null; },
      async run() {
        ran.push({ sql, args: statement.args });
        return { success: true, meta: {} };
      },
    };
    return statement as unknown as D1PreparedStatement & { sql: string; args: unknown[] };
  };

  const db = {
    prepare,
    async batch(statements: (D1PreparedStatement & { sql: string; args: unknown[] })[]) {
      if (batchFailure) throw new Error(batchFailure);
      batches.push(statements.map((entry) => ({ sql: entry.sql, args: entry.args })));
      return statements.map(() => ({ success: true, meta: {} }));
    },
  } as unknown as D1Database;

  return { db, batches, ran, failBatch: (message) => { batchFailure = message; } };
}

const CIPHERTEXT = "v1.aes-gcm.HhU5J0dNsWIrn5Yy.5wCM0v0kO6z8";
const REFRESH_CIPHERTEXT = "v1.aes-gcm.Bd1Kp2QmXzTr7Ilo.ONMt91UsFa";
const PROXY_CIPHERTEXT = "v1.aes-gcm.Zq8Lm4RnWvBc2Xef.PkTs33Ldnq";
const KEY_HASH = "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4";

function fullFixture(): Record<string, Record<string, unknown>[]> {
  return {
    providers: [{
      id: "codex", name: "OpenAI Codex", kind: "codex", base_url: "https://chatgpt.com/backend-api/codex",
      enabled: 1, pool_strategy: "round_robin", endpoints_json: "{}", auth_json: "{}", headers_json: "{}",
      options_json: "{\"session_affinity\":true}", created_at: 1_700_000_000, updated_at: 1_700_000_100,
    }],
    credentials: [{
      id: "cred-1", provider_id: "codex", label: "account-a", auth_type: "oauth",
      secret_ciphertext: CIPHERTEXT, refresh_ciphertext: REFRESH_CIPHERTEXT, expires_at: 1_800_000_000,
      enabled: 1, priority: 100, weight: 1, max_concurrency: 4, metadata_json: "{}",
      last_error: null, last_used_at: null, created_at: 1_700_000_000, updated_at: 1_700_000_100,
    }],
    model_routes: [{
      id: "route-1", public_model: "gpt-5", provider_id: "codex", upstream_model: "gpt-5",
      endpoint: "chat", enabled: 1, priority: 100, weight: 1, options_json: "{}",
      created_at: 1_700_000_000, updated_at: 1_700_000_000,
    }],
    gateway_keys: [{
      id: "key-1", name: "team", key_prefix: "cfap_ab", key_hash: KEY_HASH, enabled: 1, rpm: 60,
      max_concurrency: 8, monthly_token_limit: 0, allowed_models_json: "[]", expires_at: null,
      created_at: 1_700_000_000, updated_at: 1_700_000_000,
    }],
    model_prices: [{
      provider_id: "codex", model: "gpt-5", input_micros_per_million: 1250,
      output_micros_per_million: 10_000, cache_micros_per_million: 125, updated_at: 1_700_000_000,
    }],
    provider_proxies: [{
      provider_id: "codex", enabled: 1, bridge_url: "", proxy_url_ciphertext: PROXY_CIPHERTEXT,
      bridge_token_ciphertext: null, no_proxy_json: "[]", connect_timeout_ms: 20_000,
      request_timeout_ms: 120_000, created_at: 1_700_000_000, updated_at: 1_700_000_000,
    }],
    system_settings: [{
      key: "system_proxy_url", value_ciphertext: PROXY_CIPHERTEXT, value_json: "{}", updated_at: 1_700_000_000,
    }],
  };
}

const BACKUP_TABLE_NAMES = [
  "providers", "credentials", "model_routes", "gateway_keys",
  "model_prices", "provider_proxies", "system_settings",
];

function createEnv(db: D1Database): Env {
  const deleted: string[] = [];
  return {
    ADMIN_TOKEN: "test-admin-token",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "pw",
    APP_NAME: "CFlareAIProxy",
    DB: db,
    CONFIG_CACHE: {
      get: async () => null,
      put: async () => undefined,
      delete: async (key: string) => { deleted.push(key); },
    } as unknown as KVNamespace,
  } as Env;
}

function createTestApp() {
  const app = new Hono<{ Bindings: Env }>({ strict: false });
  app.route("/", createAdminApp());
  return app;
}

const AUTH = { "x-admin-token": "test-admin-token" };

interface ExportDocument {
  format: string;
  version: number;
  exportedAt: number;
  conflictPolicy: string;
  excludedTables: Record<string, string>;
  tables: Record<string, Record<string, unknown>[]>;
}

async function exportDocument(fixture: Record<string, Record<string, unknown>[]>): Promise<ExportDocument> {
  const fake = createFakeDb(fixture);
  const response = await createTestApp().request(
    "https://example.test/admin/api/backup/export",
    { headers: AUTH },
    createEnv(fake.db),
  );
  expect(response.status).toBe(200);
  return await response.json() as ExportDocument;
}

async function importDocument(
  body: unknown,
  fake: FakeDb,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const response = await createTestApp().request("https://example.test/admin/api/backup/import", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify(body),
  }, createEnv(fake.db));
  return { status: response.status, payload: await response.json() as Record<string, unknown> };
}

beforeEach(() => {
  // Backups stamp exportedAt from the wall clock; pinning it keeps the assertion exact.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-26T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("backup export", () => {
  it("exports every configuration table with version and timestamp", async () => {
    const document = await exportDocument(fullFixture());

    expect(document.format).toBe("cflare-api-backup");
    expect(document.version).toBe(1);
    expect(document.exportedAt).toBe(Math.floor(Date.parse("2026-07-26T00:00:00Z") / 1000));
    expect(Object.keys(document.tables).sort()).toEqual([...BACKUP_TABLE_NAMES].sort());
    for (const table of BACKUP_TABLE_NAMES) expect(document.tables[table]).toHaveLength(1);
  });

  it("keeps every column of every exported row", async () => {
    const fixture = fullFixture();
    const document = await exportDocument(fixture);

    for (const table of BACKUP_TABLE_NAMES) {
      // A migration that adds a config column must extend BACKUP_TABLES; comparing against
      // the fixture (which mirrors the shipped schema) is what catches the omission.
      expect(document.tables[table]?.[0], table).toEqual(fixture[table]?.[0]);
    }
  });

  it("copies credential and proxy ciphertext verbatim without decrypting", async () => {
    const document = await exportDocument(fullFixture());

    const credential = document.tables.credentials?.[0];
    expect(credential?.secret_ciphertext).toBe(CIPHERTEXT);
    expect(credential?.refresh_ciphertext).toBe(REFRESH_CIPHERTEXT);
    expect(document.tables.provider_proxies?.[0]?.proxy_url_ciphertext).toBe(PROXY_CIPHERTEXT);
    expect(document.tables.system_settings?.[0]?.value_ciphertext).toBe(PROXY_CIPHERTEXT);

    // No plaintext-carrying field appears anywhere in the serialized document.
    const serialized = JSON.stringify(document);
    expect(serialized).not.toMatch(/"secret"\s*:/);
    expect(serialized).not.toMatch(/"proxyUrl"\s*:/);
    expect(serialized).not.toMatch(/"refreshToken"\s*:/);
  });

  it("exports the irreversible gateway key hash so issued keys survive a restore", async () => {
    const document = await exportDocument(fullFixture());
    const key = document.tables.gateway_keys?.[0];

    // The gateway authenticates by comparing against key_hash, so restoring the hash is
    // sufficient — there is no plaintext key to recover and none to redistribute.
    expect(key?.key_hash).toBe(KEY_HASH);
    expect(key?.key_prefix).toBe("cfap_ab");
    expect(key).not.toHaveProperty("key");
  });

  it("excludes runtime tables and documents why", async () => {
    const fake = createFakeDb(fullFixture());
    const app = createTestApp();
    const selected: string[] = [];
    const env = createEnv(new Proxy(fake.db, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => {
          const table = sql.match(/FROM "(\w+)"/)?.[1];
          if (table) selected.push(table);
          return fake.db.prepare(sql);
        };
      },
    }));

    const response = await app.request("https://example.test/admin/api/backup/export", { headers: AUTH }, env);
    const document = await response.json() as ExportDocument;

    for (const runtime of ["request_logs", "request_activity_5m", "discovered_models", "quota_snapshots"]) {
      expect(selected, `${runtime} must not be read`).not.toContain(runtime);
      expect(document.tables).not.toHaveProperty(runtime);
      expect(document.excludedTables[runtime], `${runtime} needs an explanation`).toBeTruthy();
    }
  });

  it("is not capped by ADMIN_LIST_LIMIT", async () => {
    const fixture = fullFixture();
    const template = fixture.model_routes?.[0] ?? {};
    // ADMIN_LIST_LIMIT is 1000; a backup truncated there would restore a broken config.
    fixture.model_routes = Array.from({ length: 1500 }, (_, index) => ({ ...template, id: `route-${index}` }));

    const document = await exportDocument(fixture);
    expect(document.tables.model_routes).toHaveLength(1500);
  });

  it("refuses to emit a truncated backup when a table exceeds the export cap", async () => {
    const fixture = fullFixture();
    const template = fixture.model_routes?.[0] ?? {};
    fixture.model_routes = Array.from({ length: 20_001 }, (_, index) => ({ ...template, id: `route-${index}` }));

    const fake = createFakeDb(fixture);
    const response = await createTestApp().request(
      "https://example.test/admin/api/backup/export",
      { headers: AUTH },
      createEnv(fake.db),
    );

    expect(response.status).toBe(413);
    const payload = await response.json() as { error?: { code?: string } };
    expect(payload.error?.code).toBe("BACKUP_TOO_LARGE");
  });

  it("requires an admin session", async () => {
    const fake = createFakeDb(fullFixture());
    const app = createTestApp();
    const env = createEnv(fake.db);

    expect((await app.request("https://example.test/admin/api/backup/export", {}, env)).status).toBe(401);
    const post = await app.request("https://example.test/admin/api/backup/import", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }, env);
    expect(post.status).toBe(401);
  });
});

describe("backup import", () => {
  it("restores a freshly produced export through a single atomic batch", async () => {
    const document = await exportDocument(fullFixture());
    const fake = createFakeDb({});

    const { status, payload } = await importDocument(document, fake);

    expect(status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.imported).toEqual(Object.fromEntries(BACKUP_TABLE_NAMES.map((name) => [name, 1])));

    // Everything in one DB.batch(): one implicit transaction, so a partial restore is
    // impossible. Nothing may be written outside it.
    expect(fake.batches).toHaveLength(1);
    expect(fake.ran).toHaveLength(0);
    expect(fake.batches[0]).toHaveLength(BACKUP_TABLE_NAMES.length);

    // providers must precede the tables holding a foreign key onto it.
    const order = (fake.batches[0] ?? []).map((entry) => entry.sql.match(/INSERT INTO "(\w+)"/)?.[1] ?? "");
    expect(order.indexOf("providers")).toBe(0);
    for (const dependent of ["credentials", "model_routes", "provider_proxies"]) {
      expect(order.indexOf(dependent)).toBeGreaterThan(order.indexOf("providers"));
    }
  });

  it("overwrites existing rows on primary key rather than skipping them", async () => {
    const document = await exportDocument(fullFixture());
    const fake = createFakeDb({});
    await importDocument(document, fake);

    expect(document.conflictPolicy).toBe("overwrite-by-primary-key");
    for (const entry of fake.batches[0] ?? []) {
      expect(entry.sql).toMatch(/ON CONFLICT\(.+\) DO UPDATE SET /);
      expect(entry.sql).not.toMatch(/INSERT OR IGNORE|DO NOTHING/);
      // A destructive replace-all would cascade providers deletions into tables the file
      // may not cover, so no statement may delete.
      expect(entry.sql).not.toMatch(/\bDELETE\b/);
    }
    // Composite primary keys must target both columns, not just the first.
    const prices = (fake.batches[0] ?? []).find((entry) => entry.sql.includes("INTO \"model_prices\""));
    expect(prices?.sql).toContain("ON CONFLICT(\"provider_id\",\"model\")");
  });

  it("preserves ciphertext bit-for-bit through export and import", async () => {
    const document = await exportDocument(fullFixture());
    const fake = createFakeDb({});
    await importDocument(document, fake);

    const credential = (fake.batches[0] ?? []).find((entry) => entry.sql.includes("INTO \"credentials\""));
    expect(credential?.args).toContain(CIPHERTEXT);
    expect(credential?.args).toContain(REFRESH_CIPHERTEXT);
    const key = (fake.batches[0] ?? []).find((entry) => entry.sql.includes("INTO \"gateway_keys\""));
    expect(key?.args).toContain(KEY_HASH);
  });

  it("writes nothing when the batch fails", async () => {
    // The handler logs the unhandled failure; silence it so the expected path stays quiet.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const document = await exportDocument(fullFixture());
    const fake = createFakeDb({});
    fake.failBatch("FOREIGN KEY constraint failed");

    const response = await createTestApp().request("https://example.test/admin/api/backup/import", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify(document),
    }, createEnv(fake.db));

    expect(response.status).toBe(500);
    expect(fake.batches).toHaveLength(0);
    expect(fake.ran).toHaveLength(0);
  });

  it("rejects unknown format versions", async () => {
    const document = await exportDocument(fullFixture());
    const fake = createFakeDb({});

    for (const version of [0, 2, 99, "1", null]) {
      const { status, payload } = await importDocument({ ...document, version }, fake);
      expect(status, `version ${String(version)} must be rejected`).toBe(400);
      expect((payload.error as { code?: string } | undefined)?.code).toBe("BACKUP_INVALID");
    }
    expect(fake.batches).toHaveLength(0);
  });

  it("rejects a file that is not a CFlareAIProxy backup", async () => {
    const document = await exportDocument(fullFixture());
    const fake = createFakeDb({});

    const { status } = await importDocument({ ...document, format: "some-other-tool" }, fake);
    expect(status).toBe(400);
    expect(fake.batches).toHaveLength(0);
  });

  it("rejects corrupted rows before touching the database", async () => {
    const base = await exportDocument(fullFixture());
    const corrupt = (mutate: (document: ExportDocument) => void): ExportDocument => {
      const clone = JSON.parse(JSON.stringify(base)) as ExportDocument;
      mutate(clone);
      return clone;
    };

    const cases: Record<string, ExportDocument> = {
      "missing required column": corrupt((doc) => { delete doc.tables.providers?.[0]?.base_url; }),
      "wrong column type": corrupt((doc) => {
        const row = doc.tables.providers?.[0];
        if (row) row.enabled = "yes";
      }),
      "null in a non-nullable column": corrupt((doc) => {
        const row = doc.tables.credentials?.[0];
        if (row) row.secret_ciphertext = null;
      }),
      "unknown column": corrupt((doc) => {
        const row = doc.tables.providers?.[0];
        if (row) row.drop_table = "providers";
      }),
      "unknown table": corrupt((doc) => { doc.tables.request_logs = [{ request_id: "x" }]; }),
      "table is not an array": corrupt((doc) => {
        (doc.tables as Record<string, unknown>).providers = { id: "codex" };
      }),
      "row is not an object": corrupt((doc) => {
        (doc.tables as Record<string, unknown>).providers = ["codex"];
      }),
      "duplicate primary key": corrupt((doc) => {
        const row = doc.tables.providers?.[0];
        if (row) doc.tables.providers = [row, { ...row }];
      }),
      "empty primary key": corrupt((doc) => {
        const row = doc.tables.providers?.[0];
        if (row) row.id = "";
      }),
      "tables is not an object": corrupt((doc) => {
        (doc as unknown as Record<string, unknown>).tables = [];
      }),
      "no rows at all": corrupt((doc) => { doc.tables = {}; }),
    };

    for (const [label, document] of Object.entries(cases)) {
      const fake = createFakeDb({});
      const { status, payload } = await importDocument(document, fake);
      expect(status, label).toBe(400);
      expect((payload.error as { code?: string } | undefined)?.code, label).toBe("BACKUP_INVALID");
      expect(fake.batches, label).toHaveLength(0);
      expect(fake.ran, label).toHaveLength(0);
    }
  });

  it("accepts a partial backup and leaves the omitted tables alone", async () => {
    const base = await exportDocument(fullFixture());
    const fake = createFakeDb({});

    const { status, payload } = await importDocument({
      format: base.format,
      version: base.version,
      tables: { providers: base.tables.providers },
    }, fake);

    expect(status).toBe(200);
    expect((payload.imported as Record<string, number>).providers).toBe(1);
    expect((payload.imported as Record<string, number>).credentials).toBe(0);
    expect(fake.batches[0]).toHaveLength(1);
  });

  it("is idempotent: importing twice produces the same statements", async () => {
    const document = await exportDocument(fullFixture());
    const first = createFakeDb({});
    const second = createFakeDb({});

    await importDocument(document, first);
    await importDocument(document, second);

    expect(second.batches[0]).toEqual(first.batches[0]);
  });
});
