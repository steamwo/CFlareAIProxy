from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}")
    target.write_text(text.replace(old, new))


def create_file(path: str, content: str) -> None:
    target = Path(path)
    if target.exists():
        raise SystemExit(f"{path}: file already exists")
    target.write_text(content)


replace_once(
    "src/qoder-model-routing.ts",
    "export function sortModelRoutes<T extends { priority: number; weight: number; created_at: number }>(routes: T[]): T[] {",
    '''export function normalizeAllowedModelNames(\n  allowedModels: readonly string[],\n  qoderAliases: ReadonlyMap<string, string>,\n): string[] {\n  const output: string[] = [];\n  const seen = new Set<string>();\n  const legacyPrefix = `${QODER_PROVIDER_ID}/`;\n  for (const raw of allowedModels) {\n    const value = raw.trim();\n    if (!value) continue;\n    const upstreamModel = value.startsWith(legacyPrefix) ? value.slice(legacyPrefix.length) : "";\n    const normalized = upstreamModel ? qoderAliases.get(upstreamModel)?.trim() || value : value;\n    if (seen.has(normalized)) continue;\n    seen.add(normalized);\n    output.push(normalized);\n  }\n  return output;\n}\n\nexport function sortModelRoutes<T extends { priority: number; weight: number; created_at: number }>(routes: T[]): T[] {''',
)

replace_once(
    "src/db.ts",
    'import { discoveredModelAllowed, publicDiscoveredModelId, QODER_PROVIDER_ID, sortModelRoutes } from "./qoder-model-routing";',
    'import { discoveredModelAllowed, normalizeAllowedModelNames, publicDiscoveredModelId, QODER_PROVIDER_ID, sortModelRoutes } from "./qoder-model-routing";',
)

replace_once(
    "src/db.ts",
    '''export async function listRoutesForModel(\n  env: Env,\n  publicModel: string,\n  endpoint: GatewayEndpoint,\n): Promise<ModelRouteRow[]> {''',
    '''async function loadQoderAllowedModelAliases(env: Env): Promise<Map<string, string>> {\n  const result = await env.DB.prepare(\n    `SELECT model_id,display_name,discovered_at FROM discovered_models\n     WHERE provider_id='qoder' AND credential_id='' AND enabled=1\n     ORDER BY discovered_at DESC,model_id ASC`,\n  ).all<{ model_id: string; display_name: string; discovered_at: number }>();\n  const aliases = new Map<string, string>();\n  for (const row of result.results) {\n    const displayName = row.display_name.trim();\n    if (displayName && !aliases.has(row.model_id)) aliases.set(row.model_id, displayName);\n  }\n  return aliases;\n}\n\nexport async function normalizeGatewayAllowedModelLists(\n  env: Env,\n  allowedModelLists: readonly (readonly string[])[],\n): Promise<string[][]> {\n  const normalized = allowedModelLists.map((models) => normalizeAllowedModelNames(models, new Map()));\n  const legacyPrefix = `${QODER_PROVIDER_ID}/`;\n  if (!normalized.some((models) => models.some((model) => model.startsWith(legacyPrefix)))) return normalized;\n  const aliases = await loadQoderAllowedModelAliases(env);\n  return normalized.map((models) => normalizeAllowedModelNames(models, aliases));\n}\n\nexport async function normalizeGatewayAllowedModels(env: Env, allowedModels: readonly string[]): Promise<string[]> {\n  return (await normalizeGatewayAllowedModelLists(env, [allowedModels]))[0] ?? [];\n}\n\nexport async function listRoutesForModel(\n  env: Env,\n  publicModel: string,\n  endpoint: GatewayEndpoint,\n): Promise<ModelRouteRow[]> {''',
)

replace_once(
    "src/db.ts",
    '''  const now = Math.floor(Date.now() / 1000);\n  await env.DB.prepare(\n    `INSERT INTO gateway_keys''',
    '''  const now = Math.floor(Date.now() / 1000);\n  const allowedModels = await normalizeGatewayAllowedModels(env, input.allowedModels ?? []);\n  await env.DB.prepare(\n    `INSERT INTO gateway_keys''',
)
replace_once(
    "src/db.ts",
    "      JSON.stringify(input.allowedModels ?? []),",
    "      JSON.stringify(allowedModels),",
)

replace_once(
    "src/admin.ts",
    '''  getProviderProxySummary, getSystemProxySummary, listCredentialAvailabilityForModel, listCredentialRows, listModels,\n  listProviderProxySummaries, listProviders, upsertProviderProxyConfig, upsertSystemProxyUrl,''',
    '''  getProviderProxySummary, getSystemProxySummary, listCredentialAvailabilityForModel, listCredentialRows, listModels,\n  listProviderProxySummaries, listProviders, normalizeGatewayAllowedModelLists, normalizeGatewayAllowedModels,\n  upsertProviderProxyConfig, upsertSystemProxyUrl,''',
)

replace_once(
    "src/admin.ts",
    '''  app.get("/api/keys", async (c) => {\n    const result = await c.env.DB.prepare("SELECT * FROM gateway_keys ORDER BY created_at DESC").all<GatewayKeyRow>();\n    return c.json({ data: result.results.map(({key_hash,...row})=>row) });\n  });''',
    '''  app.get("/api/keys", async (c) => {\n    const result = await c.env.DB.prepare("SELECT * FROM gateway_keys ORDER BY created_at DESC").all<GatewayKeyRow>();\n    const allowedModelLists = result.results.map((row) => parseJson<string[]>(row.allowed_models_json, []));\n    const normalizedLists = await normalizeGatewayAllowedModelLists(c.env, allowedModelLists);\n    const data = result.results.map(({ key_hash, ...row }, index) => ({\n      ...row,\n      allowed_models_json: JSON.stringify(normalizedLists[index] ?? []),\n    }));\n    return c.json({ data });\n  });''',
)

replace_once(
    "src/admin.ts",
    '''    const expiresAt = body.expiresAt === null\n      ? null\n      : typeof body.expiresAt === "number" ? Math.floor(body.expiresAt) : row.expires_at;\n    await c.env.DB.prepare(''',
    '''    const expiresAt = body.expiresAt === null\n      ? null\n      : typeof body.expiresAt === "number" ? Math.floor(body.expiresAt) : row.expires_at;\n    const allowedModelsJson = Array.isArray(body.allowedModels)\n      ? JSON.stringify(await normalizeGatewayAllowedModels(\n        c.env,\n        body.allowedModels.filter((value): value is string => typeof value === "string"),\n      ))\n      : row.allowed_models_json;\n    await c.env.DB.prepare(''',
)
replace_once(
    "src/admin.ts",
    '''      Array.isArray(body.allowedModels) ? JSON.stringify(body.allowedModels.filter((value): value is string => typeof value === "string")) : row.allowed_models_json,''',
    "      allowedModelsJson,",
)

replace_once(
    "web/src/types.ts",
    '''export interface PublicModel { id: string; object?: string; owned_by?: string; display_name?: string; endpoints?: string[] }''',
    '''export interface PublicModel {\n  id: string; object?: string; owned_by?: string; display_name?: string; endpoints?: string[];\n  x_cflare_provider?: string; x_cflare_upstream_model?: string;\n}''',
)

create_file(
    "web/src/utils/model-selection.ts",
    '''import type { PublicModel } from "../types";\n\nexport interface ModelSelectOption {\n  label: string;\n  value: string;\n}\n\nexport function normalizeAllowedModelSelection(values: readonly string[], models: readonly PublicModel[]): string[] {\n  const aliases = new Map<string, string>();\n  for (const model of models) {\n    if (model.x_cflare_provider !== "qoder" || !model.x_cflare_upstream_model) continue;\n    aliases.set(`qoder/${model.x_cflare_upstream_model}`, model.id);\n  }\n\n  const output: string[] = [];\n  const seen = new Set<string>();\n  for (const raw of values) {\n    const value = raw.trim();\n    if (!value) continue;\n    const normalized = aliases.get(value) ?? value;\n    if (seen.has(normalized)) continue;\n    seen.add(normalized);\n    output.push(normalized);\n  }\n  return output;\n}\n\nexport function publicModelOptions(models: readonly PublicModel[]): ModelSelectOption[] {\n  return models.map((model) => {\n    const displayName = model.display_name?.trim();\n    return {\n      label: displayName && displayName !== model.id ? `${displayName} · ${model.id}` : model.id,\n      value: model.id,\n    };\n  });\n}\n''',
)

create_file(
    "web/src/utils/model-selection.test.ts",
    '''import { describe, expect, it } from "vitest";\nimport { normalizeAllowedModelSelection, publicModelOptions } from "./model-selection";\nimport type { PublicModel } from "../types";\n\nconst models: PublicModel[] = [\n  {\n    id: "Claude Sonnet",\n    display_name: "Claude Sonnet",\n    x_cflare_provider: "qoder",\n    x_cflare_upstream_model: "anon-a8f3",\n  },\n  { id: "codex/gpt-5", display_name: "GPT-5" },\n];\n\ndescribe("gateway-key model selection", () => {\n  it("maps legacy Qoder anonymous values to public display names", () => {\n    expect(normalizeAllowedModelSelection(["qoder/anon-a8f3", "Claude Sonnet", "codex/gpt-5"], models))\n      .toEqual(["Claude Sonnet", "codex/gpt-5"]);\n  });\n\n  it("preserves unknown legacy values instead of silently dropping access", () => {\n    expect(normalizeAllowedModelSelection(["qoder/unknown"], models)).toEqual(["qoder/unknown"]);\n  });\n\n  it("uses public ids as values and readable labels", () => {\n    expect(publicModelOptions(models)).toEqual([\n      { label: "Claude Sonnet", value: "Claude Sonnet" },\n      { label: "GPT-5 · codex/gpt-5", value: "codex/gpt-5" },\n    ]);\n  });\n});\n''',
)

replace_once(
    "web/src/views/KeysView.vue",
    'import { h, onMounted, reactive, ref } from "vue";',
    'import { computed, h, onMounted, reactive, ref } from "vue";',
)
replace_once(
    "web/src/views/KeysView.vue",
    'import { formatTokens } from "../utils/format";',
    'import { formatTokens } from "../utils/format";\nimport { normalizeAllowedModelSelection, publicModelOptions } from "../utils/model-selection";',
)
replace_once(
    "web/src/views/KeysView.vue",
    '''const form = reactive({ name: "", rpm: 60, maxConcurrency: 8, monthlyTokenLimit: 0, allowedModels: [] as string[], enabled: true });''',
    '''const form = reactive({ name: "", rpm: 60, maxConcurrency: 8, monthlyTokenLimit: 0, allowedModels: [] as string[], enabled: true });\nconst modelOptions = computed(() => publicModelOptions(models.value));''',
)
replace_once(
    "web/src/views/KeysView.vue",
    '''function edit(row: GatewayKey) { editing.value = row; Object.assign(form, { name: row.name, rpm: row.rpm, maxConcurrency: row.max_concurrency, monthlyTokenLimit: row.monthly_token_limit, allowedModels: JSON.parse(row.allowed_models_json || "[]"), enabled: row.enabled === 1 }); modal.value = true; }''',
    '''function edit(row: GatewayKey) {\n  editing.value = row;\n  const storedModels = JSON.parse(row.allowed_models_json || "[]") as string[];\n  Object.assign(form, {\n    name: row.name, rpm: row.rpm, maxConcurrency: row.max_concurrency,\n    monthlyTokenLimit: row.monthly_token_limit,\n    allowedModels: normalizeAllowedModelSelection(storedModels, models.value),\n    enabled: row.enabled === 1,\n  });\n  modal.value = true;\n}''',
)
replace_once(
    "web/src/views/KeysView.vue",
    '''  try {\n    if (editing.value) await api(`/keys/${editing.value.id}`, { method: "PATCH", body: jsonBody(form) });\n    else {\n      const result = await api<{ id: string; key: string }>("/keys", { method: "POST", body: jsonBody(form) });''',
    '''  try {\n    const payload = { ...form, allowedModels: normalizeAllowedModelSelection(form.allowedModels, models.value) };\n    if (editing.value) await api(`/keys/${editing.value.id}`, { method: "PATCH", body: jsonBody(payload) });\n    else {\n      const result = await api<{ id: string; key: string }>("/keys", { method: "POST", body: jsonBody(payload) });''',
)
replace_once(
    "web/src/views/KeysView.vue",
    ''':options="models.map(model => ({ label: model.id, value: model.id }))"''',
    ''':options="modelOptions"''',
)

replace_once(
    "test/qoder-model-routing.test.ts",
    'import { gatewayKeyAllowsModel, listRoutesForModel } from "../src/db";',
    'import { gatewayKeyAllowsModel, listRoutesForModel, normalizeGatewayAllowedModelLists, normalizeGatewayAllowedModels } from "../src/db";',
)
replace_once(
    "test/qoder-model-routing.test.ts",
    '''  discoveredModelAllowed,\n  discoveryCredentialScopes,\n  publicDiscoveredModelId,''',
    '''  discoveredModelAllowed,\n  discoveryCredentialScopes,\n  normalizeAllowedModelNames,\n  publicDiscoveredModelId,''',
)
replace_once(
    "test/qoder-model-routing.test.ts",
    '''  it("sorts automatic Qoder routes together with explicit provider routes", () => {''',
    '''  it("normalizes legacy Qoder model restrictions and removes duplicates", () => {\n    const aliases = new Map([["anon-a8f3", "Claude Sonnet"]]);\n    expect(normalizeAllowedModelNames(\n      [" qoder/anon-a8f3 ", "Claude Sonnet", "codex/gpt-5", "", "qoder/unknown"],\n      aliases,\n    )).toEqual(["Claude Sonnet", "codex/gpt-5", "qoder/unknown"]);\n  });\n\n  it("normalizes multiple gateway-key model lists with one channel lookup", async () => {\n    let queries = 0;\n    const db = new FakeDatabase((sql) => {\n      queries += 1;\n      expect(sql).toContain("credential_id='' AND enabled=1");\n      return { all: [\n        { model_id: "anon-a8f3", display_name: "Claude Sonnet", discovered_at: 20 },\n        { model_id: "anon-a8f3", display_name: "Old Name", discovered_at: 10 },\n      ] };\n    });\n    const env = envWithDatabase(db);\n    await expect(normalizeGatewayAllowedModelLists(env, [\n      ["qoder/anon-a8f3", "codex/gpt-5"],\n      ["qoder/anon-a8f3", "Claude Sonnet"],\n    ])).resolves.toEqual([\n      ["Claude Sonnet", "codex/gpt-5"],\n      ["Claude Sonnet"],\n    ]);\n    expect(queries).toBe(1);\n    await expect(normalizeGatewayAllowedModels(env, ["codex/gpt-5"])).resolves.toEqual(["codex/gpt-5"]);\n    expect(queries).toBe(1);\n  });\n\n  it("sorts automatic Qoder routes together with explicit provider routes", () => {''',
)

replace_once(
    "docs/qoder-model-routing.md",
    '''- 网关密钥中已有的 `qoder/<匿名模型名>` 模型限制仍会授权对应的公开 `display_name`。''',
    '''- 网关密钥中已有的 `qoder/<匿名模型名>` 模型限制仍会授权对应的公开 `display_name`。管理接口和密钥编辑页面会将可识别的历史匿名值转换成公开名称，后续保存统一写入公开名称；无法识别的旧值会保留，避免静默扩大或缩小权限。''',
)
