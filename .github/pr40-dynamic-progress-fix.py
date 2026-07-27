from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, value: str) -> None:
    Path(path).write_text(value, encoding="utf-8")


def replace_once(value: str, old: str, new: str, label: str) -> str:
    count = value.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return value.replace(old, new, 1)


models_path = "src/models.ts"
models = read(models_path)
models = replace_once(
    models,
    'import { normalizeBaseUrl } from "./utils";',
    'import { base64Decode, base64UrlDecode, base64UrlEncode, normalizeBaseUrl } from "./utils";',
    "models utils import",
)

old_cursor = '''interface ProviderModelRefreshCursor {
  version: 1;
  providerId: string;
  attemptedBefore: number;
  total: number;
  completed: number;
}

function encodeProviderModelRefreshCursor(cursor: ProviderModelRefreshCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeProviderModelRefreshCursor(
  providerId: string,
  cursor?: string,
): ProviderModelRefreshCursor | undefined {
  if (!cursor) return undefined;
  try {
    if (cursor.length > 1024) throw new Error("cursor is too long");
    const normalized = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ProviderModelRefreshCursor>;
    if (
      parsed.version !== 1
      || parsed.providerId !== providerId
      || !Number.isInteger(parsed.attemptedBefore)
      || Number(parsed.attemptedBefore) <= 0
      || !Number.isInteger(parsed.total)
      || Number(parsed.total) < 0
      || !Number.isInteger(parsed.completed)
      || Number(parsed.completed) < 0
      || Number(parsed.completed) > Number(parsed.total)
    ) throw new Error("invalid cursor payload");
    return parsed as ProviderModelRefreshCursor;
  } catch {
    throw new GatewayError(400, "MODEL_REFRESH_CURSOR_INVALID", "Invalid provider model refresh cursor");
  }
}

'''

new_cursor = '''interface ProviderModelRefreshCursor {
  version: 2;
  providerId: string;
  attemptedBefore: number;
}

const providerRefreshCursorEncoder = new TextEncoder();
const providerRefreshCursorDecoder = new TextDecoder();
const providerRefreshCursorKeyCache = new Map<string, Promise<CryptoKey>>();
const PROVIDER_REFRESH_CURSOR_KEY_CACHE_LIMIT = 4;
const PROVIDER_REFRESH_CURSOR_CONTEXT = providerRefreshCursorEncoder.encode(
  "CFlareAIProxy/provider-model-refresh-cursor/v2",
);

function invalidProviderModelRefreshCursor(): GatewayError {
  return new GatewayError(400, "MODEL_REFRESH_CURSOR_INVALID", "Invalid provider model refresh cursor");
}

async function providerRefreshCursorKey(
  base64Key: string | undefined,
  slot: "MASTER_KEY" | "MASTER_KEY_PREVIOUS",
): Promise<CryptoKey> {
  const normalized = typeof base64Key === "string" ? base64Key.trim() : "";
  if (!normalized) {
    throw new GatewayError(
      503,
      "MASTER_KEY_MISSING",
      "MASTER_KEY is not configured. Set it to a base64-encoded 32-byte Worker secret and redeploy.",
      "configuration_error",
    );
  }
  const cached = providerRefreshCursorKeyCache.get(normalized);
  if (cached) return cached;

  const pending = (async () => {
    let raw: Uint8Array<ArrayBuffer>;
    try {
      raw = base64Decode(normalized);
    } catch {
      throw new GatewayError(
        503,
        slot === "MASTER_KEY" ? "INVALID_MASTER_KEY" : "INVALID_MASTER_KEY_PREVIOUS",
        `${slot} is invalid. It must be a base64-encoded 32-byte key.`,
        "configuration_error",
      );
    }
    if (raw.byteLength !== 32) {
      throw new GatewayError(
        503,
        slot === "MASTER_KEY" ? "INVALID_MASTER_KEY" : "INVALID_MASTER_KEY_PREVIOUS",
        `${slot} is invalid. It must be a base64-encoded 32-byte key.`,
        "configuration_error",
      );
    }
    const material = new Uint8Array(raw.byteLength + PROVIDER_REFRESH_CURSOR_CONTEXT.byteLength);
    material.set(raw);
    material.set(PROVIDER_REFRESH_CURSOR_CONTEXT, raw.byteLength);
    const derived = await crypto.subtle.digest("SHA-256", material);
    return crypto.subtle.importKey(
      "raw",
      derived,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  })();
  pending.catch(() => {
    if (providerRefreshCursorKeyCache.get(normalized) === pending) {
      providerRefreshCursorKeyCache.delete(normalized);
    }
  });
  if (providerRefreshCursorKeyCache.size >= PROVIDER_REFRESH_CURSOR_KEY_CACHE_LIMIT) {
    providerRefreshCursorKeyCache.clear();
  }
  providerRefreshCursorKeyCache.set(normalized, pending);
  return pending;
}

async function encodeProviderModelRefreshCursor(
  env: Env,
  cursor: ProviderModelRefreshCursor,
): Promise<string> {
  const payload = base64UrlEncode(providerRefreshCursorEncoder.encode(JSON.stringify(cursor)));
  const key = await providerRefreshCursorKey(env.MASTER_KEY, "MASTER_KEY");
  const signature = await crypto.subtle.sign("HMAC", key, providerRefreshCursorEncoder.encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function verifyProviderModelRefreshCursorSignature(
  env: Env,
  payload: string,
  signature: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const encoded = providerRefreshCursorEncoder.encode(payload);
  const current = await providerRefreshCursorKey(env.MASTER_KEY, "MASTER_KEY");
  if (await crypto.subtle.verify("HMAC", current, signature, encoded)) return true;
  const previous = typeof env.MASTER_KEY_PREVIOUS === "string" ? env.MASTER_KEY_PREVIOUS.trim() : "";
  if (!previous) return false;
  const previousKey = await providerRefreshCursorKey(previous, "MASTER_KEY_PREVIOUS");
  return crypto.subtle.verify("HMAC", previousKey, signature, encoded);
}

async function decodeProviderModelRefreshCursor(
  env: Env,
  providerId: string,
  cursor?: string,
): Promise<ProviderModelRefreshCursor | undefined> {
  if (!cursor) return undefined;
  try {
    if (cursor.length > 2048) throw new Error("cursor is too long");
    const parts = cursor.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("invalid cursor envelope");
    const [payload, signatureValue] = parts;
    const signature = base64UrlDecode(signatureValue);
    if (!await verifyProviderModelRefreshCursorSignature(env, payload, signature)) {
      throw new Error("cursor signature mismatch");
    }
    const parsed = JSON.parse(
      providerRefreshCursorDecoder.decode(base64UrlDecode(payload)),
    ) as Partial<ProviderModelRefreshCursor>;
    if (
      parsed.version !== 2
      || parsed.providerId !== providerId
      || !Number.isInteger(parsed.attemptedBefore)
      || Number(parsed.attemptedBefore) <= 0
    ) throw new Error("invalid cursor payload");
    return parsed as ProviderModelRefreshCursor;
  } catch (error) {
    if (error instanceof GatewayError && error.status === 503) throw error;
    throw invalidProviderModelRefreshCursor();
  }
}

'''
models = replace_once(models, old_cursor, new_cursor, "provider cursor implementation")

start = models.index("export async function runProviderModelRefreshPage(")
end = models.index("export async function refreshAllModels(", start)
new_provider_block = '''export async function runProviderModelRefreshPage(
  env: Env,
  providerId: string,
  limit = MODEL_REFRESH_BATCH_LIMIT,
  cursor?: string,
): Promise<ProviderModelRefreshPage> {
  const boundedLimit = Math.max(1, Math.min(MODEL_REFRESH_BATCH_LIMIT, Math.floor(limit) || MODEL_REFRESH_BATCH_LIMIT));
  const existingCycle = await decodeProviderModelRefreshCursor(env, providerId, cursor);
  const attemptedBefore = existingCycle?.attemptedBefore ?? Math.floor(Date.now() / 1000);
  const provider = await getProvider(env, providerId);
  const page = await env.DB.prepare(
    `SELECT c.id
     FROM credentials c
     LEFT JOIN credential_refresh_attempts a ON a.credential_id=c.id
     WHERE c.provider_id=? AND c.enabled=1
       AND COALESCE(a.model_attempted_at, 0) < ?
     ORDER BY COALESCE(a.model_attempted_at, 0) ASC, c.priority, c.created_at
     LIMIT ?`,
  ).bind(providerId, attemptedBefore, boundedLimit).all<{ id: string }>();

  const results: ModelRefreshResult[] = [];
  const providerCache: ProviderCache = new Map([[providerId, Promise.resolve(provider)]]);
  const proxyCache: ProviderProxyCache = new Map();
  if (providerId === "opencode" && !existingCycle) {
    results.push(await refreshOpenCodeAnonymousModels(env, providerCache, proxyCache, false));
  }
  for (let index = 0; index < page.results.length; index += MODEL_REFRESH_CONCURRENCY) {
    const group = page.results.slice(index, index + MODEL_REFRESH_CONCURRENCY);
    await markModelRefreshAttempts(env, group.map((row) => row.id));
    results.push(...await Promise.all(
      group.map((row) => refreshCredentialModels(env, row.id, providerCache, proxyCache, false)),
    ));
  }
  if (results.some((item) => item.count > 0)) await invalidateModelCache(env);

  // Dynamic-cycle semantics: new enabled credentials join the active cycle, while credentials
  // completed by another coordinated sweep or disabled during the cycle stop counting as pending.
  // Recompute both values from current D1 state instead of trying to infer two independent changes
  // from one net delta carried in the cursor.
  const progress = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN COALESCE(a.model_attempted_at, 0) < ? THEN 1 ELSE 0 END), 0) AS remaining
     FROM credentials c
     LEFT JOIN credential_refresh_attempts a ON a.credential_id=c.id
     WHERE c.provider_id=? AND c.enabled=1`,
  ).bind(attemptedBefore, providerId).first<{ total: number; remaining: number }>();
  const total = Math.max(0, Number(progress?.total ?? 0));
  const remaining = Math.max(0, Math.min(total, Number(progress?.remaining ?? 0)));
  const processedInCycle = total - remaining;
  const complete = remaining === 0;
  return {
    providerId,
    results,
    processed: page.results.length,
    processedInCycle,
    total,
    remaining,
    complete,
    nextCursor: complete ? undefined : await encodeProviderModelRefreshCursor(env, {
      version: 2,
      providerId,
      attemptedBefore,
    }),
  };
}

export async function refreshProviderModels(
  env: Env,
  providerId: string,
  limit = MODEL_REFRESH_BATCH_LIMIT,
  cursor?: string,
): Promise<ProviderModelRefreshPage> {
  await decodeProviderModelRefreshCursor(env, providerId, cursor);
  const namespace = env.RATE_LIMITER;
  if (!namespace) return runProviderModelRefreshPage(env, providerId, limit, cursor);
  const stub = namespace.get(namespace.idFromName(MODEL_REFRESH_DO_NAME));
  const response = await stub.fetch(`https://do.internal/models/refresh/provider/${encodeURIComponent(providerId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ limit, cursor }),
  });
  if (!response.ok) throw new Error(`provider model refresh coordinator returned ${response.status}`);
  return await response.json() as ProviderModelRefreshPage;
}

'''
models = models[:start] + new_provider_block + models[end:]
write(models_path, models)

test_path = "test/model-refresh-d1-budget.test.ts"
test = read(test_path)
test = replace_once(
    test,
    'import { encryptSecret } from "../src/crypto";\n',
    'import { encryptSecret } from "../src/crypto";\nimport { base64UrlDecode, base64UrlEncode } from "../src/utils";\n',
    "test utils import",
)

create_start = test.index("async function createEnv(input:")
create_end = test.index('\ndescribe("model refresh budgets"', create_start)
new_create = '''interface EnvControls {
  addCredential: (id: string, providerId: string) => void;
  markAttempted: (ids: string[]) => void;
}

async function createEnv(input: {
  ids: string[];
  providerFor: (id: string, index: number) => string;
}): Promise<{ env: Env; budget: Budget; resetBudget: () => void; controls: EnvControls }> {
  const masterKey = Buffer.alloc(32, 7).toString("base64");
  const ciphertext = await encryptSecret("token", masterKey);
  const ids = [...input.ids];
  const credentials = new Map<string, CredentialRow>();
  const providers = new Map<string, ProviderRow>();

  const addCredential = (id: string, providerId: string): void => {
    const index = credentials.size;
    ids.push(id);
    credentials.set(id, {
      id,
      provider_id: providerId,
      label: id,
      auth_type: "api_key",
      secret_ciphertext: ciphertext,
      refresh_ciphertext: null,
      expires_at: null,
      enabled: 1,
      priority: 0,
      weight: 1,
      max_concurrency: 1,
      metadata_json: "{}",
      last_error: null,
      last_used_at: null,
      created_at: index,
      updated_at: index,
    });
    if (!providers.has(providerId)) providers.set(providerId, providerRow(providerId, index));
  };
  ids.splice(0);
  for (const [index, id] of input.ids.entries()) addCredential(id, input.providerFor(id, index));

  const attempted = new Set<string>();
  const budget: Budget = { d1: 0, subrequests: 0, cacheDeletes: 0 };
  const resetBudget = (): void => {
    budget.d1 = 0;
    budget.subrequests = 0;
    budget.cacheDeletes = 0;
  };
  const spendD1 = (count = 1): void => {
    budget.d1 += count;
    budget.subrequests += count;
    if (budget.d1 > 50) throw new Error(`D1 query limit exceeded at ${budget.d1}`);
    if (budget.subrequests > 50) throw new Error(`subrequest limit exceeded at ${budget.subrequests}`);
  };

  const statement = (sql: string, binds: unknown[] = []): D1PreparedStatement => ({
    bind: (...args: unknown[]) => statement(sql, args),
    async all() {
      spendD1();
      if (sql.includes("AND COALESCE(a.model_attempted_at, 0) < ?")) {
        const providerId = String(binds[0]);
        const limit = Number(binds.at(-1) ?? MODEL_REFRESH_BATCH_LIMIT);
        const eligible = ids.filter((id) => {
          const credential = credentials.get(id);
          return credential?.provider_id === providerId && credential.enabled === 1 && !attempted.has(id);
        });
        return { results: eligible.slice(0, limit).map((id) => ({ id })), success: true, meta: {} } as never;
      }
      if (sql.includes("SELECT c.id FROM credentials c")) {
        const limit = Number(binds[0] ?? MODEL_REFRESH_BATCH_LIMIT);
        return { results: ids.slice(0, limit).map((id) => ({ id })), success: true, meta: {} } as never;
      }
      return { results: [], success: true, meta: {} } as never;
    },
    async first() {
      spendD1();
      if (sql.includes("COUNT(*) AS total") && sql.includes("AS remaining")) {
        const providerId = String(binds[1]);
        const enabled = ids.filter((id) => {
          const credential = credentials.get(id);
          return credential?.provider_id === providerId && credential.enabled === 1;
        });
        return {
          total: enabled.length,
          remaining: enabled.filter((id) => !attempted.has(id)).length,
        } as never;
      }
      if (sql.includes("SELECT enabled FROM providers WHERE id='opencode'")) return { enabled: 0 } as never;
      if (sql.includes("SELECT * FROM credentials WHERE id = ?")) return credentials.get(String(binds[0])) as never;
      if (sql.includes("SELECT * FROM providers WHERE id = ? AND enabled = 1")) return providers.get(String(binds[0])) as never;
      if (sql.includes("FROM provider_proxies WHERE provider_id=?")) return null;
      if (sql.includes("FROM system_settings WHERE key='system_proxy_url'")) return null;
      return null;
    },
    async run() {
      spendD1();
      if (sql.includes("INSERT INTO credential_refresh_attempts")) {
        for (const id of JSON.parse(String(binds[1] ?? "[]")) as string[]) attempted.add(id);
      }
      return { success: true, meta: { changes: 1 } } as never;
    },
    async raw() {
      throw new Error("not used");
    },
  } as D1PreparedStatement);

  const DB = {
    prepare: (sql: string) => statement(sql),
    async batch(statements: D1PreparedStatement[]) {
      spendD1(statements.length);
      return statements.map(() => ({ success: true, meta: {} }));
    },
  } as unknown as D1Database;

  vi.stubGlobal("fetch", vi.fn(async () => {
    budget.subrequests += 1;
    if (budget.subrequests > 50) throw new Error(`subrequest limit exceeded at ${budget.subrequests}`);
    return new Response(JSON.stringify({ data: [{ id: "model-1", name: "Model 1" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }));

  const env = {
    DB,
    MASTER_KEY: masterKey,
    CONFIG_CACHE: {
      delete: async () => {
        budget.cacheDeletes += 1;
        budget.subrequests += 1;
        if (budget.subrequests > 50) throw new Error(`subrequest limit exceeded at ${budget.subrequests}`);
      },
    } as unknown as KVNamespace,
  } as Env;
  return {
    env,
    budget,
    resetBudget,
    controls: {
      addCredential,
      markAttempted: (credentialIds) => {
        for (const id of credentialIds) attempted.add(id);
      },
    },
  };
}
'''
test = test[:create_start] + new_create + test[create_end:]

insert = r'''
  it("recomputes dynamic progress when additions and external completions overlap", async () => {
    const ids = Array.from({ length: 16 }, (_, index) => `c${index + 1}`);
    const { env, controls, resetBudget } = await createEnv({ ids, providerFor: () => "p1" });
    const first = await runProviderModelRefreshPage(env, "p1");
    expect(first.processedInCycle).toBe(5);
    expect(first.remaining).toBe(11);

    controls.markAttempted(["c6", "c7"]);
    controls.addCredential("c17", "p1");
    controls.addCredential("c18", "p1");
    controls.addCredential("c19", "p1");
    resetBudget();

    const second = await runProviderModelRefreshPage(
      env,
      "p1",
      MODEL_REFRESH_BATCH_LIMIT,
      first.nextCursor,
    );
    expect(second.processed).toBe(5);
    expect(second.total).toBe(19);
    expect(second.processedInCycle).toBe(12);
    expect(second.remaining).toBe(7);
  });

  it("rejects a structurally valid cursor whose signed cutoff was modified", async () => {
    const ids = Array.from({ length: 6 }, (_, index) => `c${index + 1}`);
    const { env } = await createEnv({ ids, providerFor: () => "p1" });
    const first = await runProviderModelRefreshPage(env, "p1");
    const [payload, signature] = String(first.nextCursor).split(".");
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as {
      attemptedBefore: number;
    };
    const modifiedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({
      ...parsed,
      attemptedBefore: parsed.attemptedBefore + 3600,
    })));

    await expect(runProviderModelRefreshPage(
      env,
      "p1",
      MODEL_REFRESH_BATCH_LIMIT,
      `${modifiedPayload}.${signature}`,
    )).rejects.toMatchObject({
      status: 400,
      code: "MODEL_REFRESH_CURSOR_INVALID",
    });
  });
'''
closing = "\n});\n"
if not test.endswith(closing):
    raise RuntimeError("test closing marker not found")
test = test[:-len(closing)] + insert + closing
write(test_path, test)
