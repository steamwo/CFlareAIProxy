export type ProviderKind =
  | "openai-compatible"
  | "codex"
  | "kimi"
  | "qoder"
  | "opencode"
  | "custom";

export type GatewayEndpoint = "responses" | "chat" | "completions";
export type PoolStrategy = "round_robin" | "fill_first" | "weighted" | "least_inflight";
export type ProxyProtocol = "http" | "https" | "socks" | "socks4" | "socks4a" | "socks5" | "socks5h";

export interface Env {
  DB: D1Database;
  CONFIG_CACHE: KVNamespace;
  ACCOUNT_POOL: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  USAGE_QUEUE: Queue<UsageEvent>;
  ASSETS: Fetcher;
  MASTER_KEY: string;
  ADMIN_TOKEN: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  APP_NAME?: string;
  MAX_BODY_BYTES?: string;
  DEFAULT_RPM?: string;
  DEFAULT_CONCURRENCY?: string;
  DEFAULT_MONTHLY_TOKENS?: string;
  CREDENTIAL_COOLDOWN_MS?: string;
  PUBLIC_BASE_URL?: string;
  PROXY_BRIDGE_URL?: string;
  PROXY_BRIDGE_TOKEN?: string;
}

export interface ProviderRow {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url: string;
  enabled: number;
  pool_strategy: PoolStrategy;
  endpoints_json: string;
  auth_json: string;
  headers_json: string;
  options_json: string;
  created_at: number;
  updated_at: number;
}


export interface ProviderProxyRow {
  provider_id: string;
  enabled: number;
  bridge_url: string;
  proxy_url_ciphertext: string | null;
  bridge_token_ciphertext: string | null;
  no_proxy_json: string;
  connect_timeout_ms: number;
  request_timeout_ms: number;
  created_at: number;
  updated_at: number;
}

export interface ProviderProxyConfig {
  providerId: string;
  enabled: boolean;
  bridgeUrl: string;
  proxyUrl: string;
  bridgeToken: string;
  noProxy: string[];
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  source: "provider" | "system";
}

export interface ProviderProxySummary {
  enabled: boolean;
  source: "provider" | "system" | "direct";
  proxyProtocol?: ProxyProtocol;
  proxyHost?: string;
  hasProviderOverride: boolean;
  hasSystemProxy: boolean;
  bridgeConfigured: boolean;
  runtimeReady: boolean;
}

export interface SystemProxySummary {
  enabled: boolean;
  proxyProtocol?: ProxyProtocol;
  proxyHost?: string;
  bridgeConfigured: boolean;
  runtimeReady: boolean;
}

export interface CredentialRow {
  id: string;
  provider_id: string;
  label: string;
  auth_type: string;
  secret_ciphertext: string;
  refresh_ciphertext: string | null;
  expires_at: number | null;
  enabled: number;
  priority: number;
  weight: number;
  max_concurrency: number;
  metadata_json: string;
  last_error: string | null;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ModelRouteRow {
  id: string;
  public_model: string;
  provider_id: string;
  upstream_model: string;
  endpoint: GatewayEndpoint;
  enabled: number;
  priority: number;
  weight: number;
  options_json: string;
  created_at: number;
  updated_at: number;
}

export interface DiscoveredModelRow {
  provider_id: string;
  credential_id: string;
  model_id: string;
  display_name: string;
  endpoint: GatewayEndpoint;
  owned_by: string;
  capabilities_json: string;
  raw_json: string;
  enabled: number;
  discovered_at: number;
}

export interface QuotaSnapshotRow {
  credential_id: string;
  provider_id: string;
  status: QuotaSnapshot["status"];
  quota_json: string;
  error_message: string | null;
  fetched_at: number;
  expires_at: number | null;
}

export interface QuotaWindow {
  key: string;
  label: string;
  limit?: number;
  remaining?: number;
  usedPercent?: number;
  remainingPercent?: number;
  resetAt?: number;
  windowSeconds?: number;
}

export interface QuotaSnapshot {
  provider: string;
  plan?: string;
  status: "ok" | "unsupported" | "error" | "unknown";
  windows: QuotaWindow[];
  credits?: {
    balance?: string | number;
    unlimited?: boolean;
    hasCredits?: boolean;
  };
  source: "api" | "configured" | "headers";
  raw?: Record<string, unknown>;
}

export interface GatewayKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  enabled: number;
  rpm: number;
  max_concurrency: number;
  monthly_token_limit: number;
  allowed_models_json: string;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ProviderConfig extends ProviderRow {
  endpoints: Record<string, string>;
  auth: Record<string, unknown>;
  headers: Record<string, string>;
  options: Record<string, unknown>;
}

export interface Credential extends CredentialRow {
  secret: string;
  refreshToken?: string;
  metadata: Record<string, unknown>;
}

export interface PoolCandidate {
  id: string;
  priority: number;
  weight: number;
  maxConcurrency: number;
  enabled: boolean;
}

export interface PoolLease {
  leaseId: string;
  credentialId: string;
  expiresAt: number;
}

export interface RateLease {
  leaseId: string;
  allowed: boolean;
  retryAfterMs?: number;
  reason?: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
}

export interface UsageEvent {
  requestId: string;
  gatewayKeyId?: string;
  providerId?: string;
  credentialId?: string;
  publicModel?: string;
  upstreamModel?: string;
  endpoint?: string;
  statusCode: number;
  usage: Usage;
  latencyMs: number;
  firstTokenMs?: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: number;
}

export type UpstreamResponseMode =
  | "passthrough"
  | "codex-chat"
  | "qoder-chat"
  | "anthropic-chat"
  | "google-chat";

export interface UpstreamBuildResult {
  url: string;
  init: RequestInit;
  responseMode: UpstreamResponseMode;
}

export interface ProxyRequestContext {
  requestId: string;
  endpoint: GatewayEndpoint;
  publicModel: string;
  upstreamModel: string;
  body: Record<string, unknown>;
  originalRequest: Request;
  provider: ProviderConfig;
  credential: Credential;
}
