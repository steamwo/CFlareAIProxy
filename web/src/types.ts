export type PoolStrategy = "round_robin" | "fill_first" | "weighted" | "least_inflight";

export interface ApiEnvelope<T> { data: T }
export interface Session { authenticated: boolean; username: string; expiresAt: number; service: string }
export interface ProxySummary {
  enabled: boolean;
  source?: "provider" | "system" | "direct";
  proxyProtocol?: string;
  proxyHost?: string;
  hasProviderOverride?: boolean;
  hasSystemProxy?: boolean;
  bridgeConfigured?: boolean;
  runtimeReady?: boolean;
}
export interface Channel {
  id: string; name: string; kind: string; base_url: string; enabled: number;
  pool_strategy: PoolStrategy; description: string; authMode: string;
  accountCount: number; enabledAccountCount: number; modelCount: number;
  proxy?: ProxySummary;
}
export interface Provider {
  id: string; name: string; kind: string; base_url: string; enabled: number;
  pool_strategy: PoolStrategy; apiMode: "chat" | "responses" | "both";
  routingWeight?: number; modelSelections?: Array<{ upstreamModel: string; publicModel: string; endpoints?: string[] }>;
  proxy?: ProxySummary;
}
export interface Credential {
  id: string; provider_id: string; label: string; auth_type: string; expires_at: number | null;
  enabled: number; priority: number; weight: number; max_concurrency: number;
  metadata_json: string; metadata?: Record<string, unknown>; last_error: string | null; last_used_at: number | null;
  created_at: number; updated_at: number;
}
export interface DiscoveredModel {
  provider_id: string; credential_id: string; model_id: string; display_name: string;
  endpoint: string; owned_by: string; enabled: number; discovered_at: number;
}
export interface PublicModel { id: string; object?: string; owned_by?: string; display_name?: string; endpoints?: string[] }
export interface QuotaWindow {
  key: string; label: string; limit?: number; remaining?: number; usedPercent?: number;
  remainingPercent?: number; resetAt?: number; windowSeconds?: number;
}
export interface QuotaSnapshot {
  credential_id: string; provider_id: string; status: string; quota_json: string;
  error_message: string | null; fetched_at: number; expires_at: number | null;
  snapshot?: { plan?: string; windows?: QuotaWindow[]; credits?: { balance?: string | number; unlimited?: boolean; hasCredits?: boolean } };
}
export interface ModelRoute {
  id: string; public_model: string; provider_id: string; upstream_model: string;
  endpoint: string; enabled: number; priority: number; weight: number; options_json: string;
  health?: { failures: number; disabledUntil: number; lastStatus?: number; lastError?: string };
  availability?: { status: "ready" | "degraded" | "unavailable"; availableCredentials: number; totalCredentials: number; reason?: string; retryAt?: number };
}
export interface GatewayKey {
  id: string; name: string; key_prefix: string; enabled: number; rpm: number;
  max_concurrency: number; monthly_token_limit: number; allowed_models_json: string;
  expires_at: number | null; created_at: number;
}
export interface Price {
  provider_id: string; model: string; input_micros_per_million: number;
  output_micros_per_million: number; cache_micros_per_million: number; updated_at: number;
}
export interface RequestLog {
  request_id: string; provider_id: string | null; credential_id: string | null;
  public_model: string | null; upstream_model: string | null; endpoint: string | null;
  status_code: number; prompt_tokens: number; completion_tokens: number; cached_tokens: number; total_tokens: number;
  cost_micros: number; latency_ms: number; first_token_ms: number | null;
  error_code: string | null; error_message: string | null; created_at: number;
}
export interface Overview {
  service: string; publicBaseUrl: string; now: number;
  counts: Record<string, { total: number; enabled: number; errors?: number }>;
  usage24h: { requests: number; successes: number; successRate: number; tokens: number; costMicros: number; averageLatencyMs: number; averageFirstTokenMs: number };
  providerUsage: Array<{ provider_id: string; requests: number; tokens: number }>;
  modelUsage: Array<{ public_model: string; requests: number; tokens: number }>;
  availability: Array<{ bucket: number; requests: number; successes: number; successRate: number; averageLatencyMs: number }>;
}
