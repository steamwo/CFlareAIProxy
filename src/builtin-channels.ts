import type { PoolStrategy, ProviderKind, ProviderRow } from "./types";

export type BuiltinChannelId = "codex" | "kimi" | "qoder" | "opencode";

export interface BuiltinChannelDefinition {
  id: BuiltinChannelId;
  name: string;
  shortName: string;
  kind: Exclude<ProviderKind, "openai-compatible" | "custom">;
  description: string;
  baseUrl: string;
  authMode: "oauth-local" | "oauth-device" | "oauth-pkce-device" | "api-key";
  endpoints: Record<string, string>;
  auth: Record<string, unknown>;
  headers: Record<string, string>;
  options: Record<string, unknown>;
}

export const BUILTIN_CHANNELS: readonly BuiltinChannelDefinition[] = [
  {
    id: "codex",
    name: "OpenAI Codex",
    shortName: "Codex",
    kind: "codex",
    description: "OpenAI Codex OAuth 账号池。推荐在本机完成 PKCE 授权与 Token 交换。",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authMode: "oauth-local",
    endpoints: {
      responses: "/responses",
      chat: "/responses",
      completions: "/responses",
      models: "/models",
    },
    auth: {
      flow: "authorization_code_pkce",
      issuer: "https://auth.openai.com",
      authorize_url: "https://auth.openai.com/oauth/authorize",
      token_url: "https://auth.openai.com/oauth/token",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      scopes: ["openid", "email", "profile", "offline_access"],
      redirect_uri: "http://localhost:1455/auth/callback",
      local_exchange_recommended: true,
      authorize_param_prompt: "login",
      authorize_param_id_token_add_organizations: "true",
      authorize_param_codex_cli_simplified_flow: "true",
    },
    headers: {
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
    },
    options: { session_affinity: true },
  },
  {
    id: "kimi",
    name: "Kimi Coding",
    shortName: "Kimi",
    kind: "kimi",
    description: "Kimi Coding OAuth 账号池，支持设备授权、模型发现和额度刷新。",
    baseUrl: "https://api.kimi.com/coding/v1",
    authMode: "oauth-device",
    endpoints: {
      responses: "/responses",
      chat: "/chat/completions",
      completions: "/completions",
      models: "/models",
    },
    auth: {
      flow: "device_code",
      device_url: "https://auth.kimi.com/api/oauth/device_authorization",
      token_url: "https://auth.kimi.com/api/oauth/token",
      client_id: "17e5f671-d194-4dfb-9706-5516cb48c098",
    },
    headers: {},
    options: { session_affinity: true, request_overrides: { temperature: 0.6 } },
  },
  {
    id: "qoder",
    name: "Qoder",
    shortName: "Qoder",
    kind: "qoder",
    description: "Qoder PKCE 设备授权账号池，内置 COSY 请求签名与模型发现。",
    baseUrl: "https://api3.qoder.sh",
    authMode: "oauth-pkce-device",
    endpoints: {
      chat: "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common",
      models: "/algo/api/v2/model/list",
    },
    auth: {
      flow: "qoder_pkce_device",
      login_url: "https://qoder.com/device/selectAccounts",
      poll_url: "https://openapi.qoder.sh/api/v1/deviceToken/poll",
    },
    headers: {},
    options: { session_affinity: true },
  },
  {
    id: "opencode",
    name: "OpenCode Zen",
    shortName: "OpenCode",
    kind: "opencode",
    description: "OpenCode Zen 上游。无需账号即可使用实时匿名免费模型；配置 API Key 后可使用完整模型目录。",
    baseUrl: "https://opencode.ai/zen/v1",
    authMode: "api-key",
    endpoints: {
      responses: "/responses",
      chat: "/chat/completions",
      messages: "/messages",
      google: "/models/{model}:{action}",
      models: "/models",
    },
    auth: { header: "Authorization", prefix: "Bearer " },
    headers: {},
    options: {
      session_affinity: true,
      model_protocol_prefixes: {
        "gpt-": "responses",
        "claude-": "anthropic",
        qwen: "anthropic",
        "gemini-": "google",
      },
    },
  },
] as const;

const BUILTIN_MAP = new Map(BUILTIN_CHANNELS.map((channel) => [channel.id, channel]));

export function isBuiltinChannelId(value: string): value is BuiltinChannelId {
  return BUILTIN_MAP.has(value as BuiltinChannelId);
}

export function getBuiltinChannel(value: string): BuiltinChannelDefinition | undefined {
  return BUILTIN_MAP.get(value as BuiltinChannelId);
}

export function canonicalizeBuiltinRow(row: ProviderRow): ProviderRow {
  const definition = getBuiltinChannel(row.id);
  if (!definition) return row;
  return {
    ...row,
    name: definition.name,
    kind: definition.kind,
    base_url: definition.baseUrl,
    endpoints_json: JSON.stringify(definition.endpoints),
    auth_json: JSON.stringify(definition.auth),
    headers_json: JSON.stringify(definition.headers),
    options_json: JSON.stringify(definition.options),
  };
}

export function builtinRowValues(
  definition: BuiltinChannelDefinition,
  current?: Pick<ProviderRow, "enabled" | "pool_strategy" | "created_at">,
): Omit<ProviderRow, "updated_at"> & { updated_at: number } {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: definition.id,
    name: definition.name,
    kind: definition.kind,
    base_url: definition.baseUrl,
    enabled: current?.enabled ?? 1,
    pool_strategy: (current?.pool_strategy ?? "round_robin") as PoolStrategy,
    endpoints_json: JSON.stringify(definition.endpoints),
    auth_json: JSON.stringify(definition.auth),
    headers_json: JSON.stringify(definition.headers),
    options_json: JSON.stringify(definition.options),
    created_at: current?.created_at ?? now,
    updated_at: now,
  };
}

export function standardOpenAiConfig(mode: "chat" | "responses" | "both" = "both"): {
  endpoints: Record<string, string>;
  auth: Record<string, unknown>;
  headers: Record<string, string>;
  options: Record<string, unknown>;
} {
  const endpoints: Record<string, string> = { models: "/models" };
  if (mode === "chat" || mode === "both") {
    endpoints.chat = "/chat/completions";
    endpoints.completions = "/completions";
  }
  if (mode === "responses" || mode === "both") endpoints.responses = "/responses";
  return {
    endpoints,
    auth: { header: "Authorization", prefix: "Bearer " },
    headers: {},
    options: { session_affinity: true, api_mode: mode },
  };
}
