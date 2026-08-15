import type { Env, ProxyRequestContext, UpstreamBuildResult } from "../types";
import { GatewayError } from "../errors";
import { normalizeBaseUrl, parseJson, truncate } from "../utils";
import { buildQoderHeaders } from "./qoder-crypto";
import { qoderChatRecordId, qoderRequestSetId, qoderSessionId } from "./qoder-identity";
import { normalizeQoderRequest, qoderEncodeBody, qoderEncodedUrl, qoderResponseToolRoutes } from "./qoder-protocol";
import { rememberQoderToolRoutes } from "./qoder-tool-routes";
import { providerFetch } from "../upstream-fetch";

const encoder = new TextEncoder();

function credentialFields(context: ProxyRequestContext): {
  userId: string;
  token: string;
  name?: string;
  email?: string;
  machineId?: string;
} {
  const metadata = context.credential.metadata;
  const userId = typeof metadata.user_id === "string" ? metadata.user_id : "";
  if (!userId) {
    throw new GatewayError(503, "QODER_CREDENTIAL_INVALID", "Qoder credential is missing metadata.user_id", "upstream_error");
  }
  return {
    userId,
    token: context.credential.secret,
    name: typeof metadata.name === "string" ? metadata.name : undefined,
    email: typeof metadata.email === "string" ? metadata.email : undefined,
    machineId: typeof metadata.machine_id === "string" ? metadata.machine_id : undefined,
  };
}

function fallbackModelConfig(model: string): Record<string, unknown> {
  return {
    key: model,
    display_name: model,
    source: "system",
    is_reasoning: model.includes("think") || model.includes("reason"),
    is_vl: false,
    max_input_tokens: 131072,
    max_output_tokens: 32768,
  };
}

async function loadModelConfig(
  env: Env,
  context: ProxyRequestContext,
  credentials: ReturnType<typeof credentialFields>,
): Promise<Record<string, unknown>> {
  const cacheKey = `qoder:model-config:${context.credential.id}:${context.upstreamModel}`;
  const cached = await env.CONFIG_CACHE.get(cacheKey);
  if (cached) return parseJson<Record<string, unknown>>(cached, fallbackModelConfig(context.upstreamModel));

  const baseUrl = normalizeBaseUrl(context.provider.base_url);
  const endpoint = context.provider.endpoints.models ?? "/algo/api/v2/model/list";
  const url = endpoint.startsWith("http") ? normalizeBaseUrl(endpoint) : `${baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  const signed = await buildQoderHeaders(new Uint8Array(), url, credentials);
  const headers = new Headers(signed);
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  headers.set("accept-encoding", "identity");

  try {
    const response = await providerFetch(env, context.provider, url, { method: "GET", headers, redirect: "manual" }, { purpose: "models", timeoutMs: 20_000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as Record<string, unknown>;
    const chat = payload.chat;
    const candidates: Array<Record<string, unknown>> = [];
    if (Array.isArray(chat)) {
      for (const item of chat) if (item && typeof item === "object") candidates.push(item as Record<string, unknown>);
    } else if (chat && typeof chat === "object") {
      for (const [key, item] of Object.entries(chat as Record<string, unknown>)) {
        if (item && typeof item === "object") candidates.push({ key, ...(item as Record<string, unknown>) });
      }
    }
    const selected = candidates.find((item) => item.key === context.upstreamModel || item.model === context.upstreamModel);
    if (selected) {
      await env.CONFIG_CACHE.put(cacheKey, JSON.stringify(selected), { expirationTtl: 300 });
      return selected;
    }
  } catch (error) {
    console.warn(JSON.stringify({ event: "qoder_model_list_failed", error: error instanceof Error ? error.message : String(error) }));
  }

  const configured = context.provider.options.model_configs;
  if (configured && typeof configured === "object") {
    const item = (configured as Record<string, unknown>)[context.upstreamModel];
    if (item && typeof item === "object") return item as Record<string, unknown>;
  }
  return fallbackModelConfig(context.upstreamModel);
}

export async function buildQoderRequest(context: ProxyRequestContext, env: Env): Promise<UpstreamBuildResult> {
  if (context.endpoint === "completions") {
    throw new GatewayError(400, "QODER_ENDPOINT_UNSUPPORTED", "Qoder does not support legacy /v1/completions", "invalid_request_error");
  }
  const credentials = credentialFields(context);
  const modelConfig = await loadModelConfig(env, context, credentials);
  const normalized = await normalizeQoderRequest(context, modelConfig);
  if (context.endpoint === "responses") {
    rememberQoderToolRoutes(context.requestId, await qoderResponseToolRoutes(context.body));
  }
  const sessionId = await qoderSessionId(context.originalRequest, context.body, context.upstreamModel);
  const requestSetId = await qoderRequestSetId(sessionId, context.upstreamModel, normalized.messages, normalized.contextWindow);
  const chatRecordId = await qoderChatRecordId(
    sessionId,
    context.upstreamModel,
    normalized.messages,
    normalized.tools,
    normalized.maxTokens,
    normalized.reasoningEffort,
    normalized.contextWindow,
  );
  const parameters: Record<string, unknown> = { max_tokens: normalized.maxTokens };
  if (normalized.reasoningEffort) parameters.reasoningEffort = normalized.reasoningEffort;
  if (normalized.contextWindow > 0) parameters.contextWindow = normalized.contextWindow;
  let isReasoning = modelConfig.is_reasoning === true;
  if (normalized.reasoningEffort === "none") isReasoning = false;
  else if (normalized.reasoningEffort) isReasoning = true;

  const body: Record<string, unknown> = {
    request_id: crypto.randomUUID(),
    request_set_id: requestSetId,
    chat_record_id: chatRecordId,
    session_id: sessionId,
    stream: true,
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    code_language: "",
    chat_prompt: "",
    image_urls: null,
    aliyun_user_type: "",
    system: normalized.system,
    messages: normalized.messages,
    tools: normalized.tools,
    parameters,
    chat_context: {
      chatPrompt: "",
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: context.upstreamModel, is_reasoning: isReasoning },
        originalContent: normalized.lastUser,
      },
      features: [],
      text: normalized.lastUser,
    },
    model_config: modelConfig,
    business: {
      product: "cli",
      version: "1.0.0",
      type: "agent",
      stage: "start",
      id: crypto.randomUUID(),
      name: truncate(normalized.lastUser, 30),
      begin_at: Date.now(),
    },
  };

  const baseUrl = normalizeBaseUrl(context.provider.base_url);
  const endpoint = context.provider.endpoints.chat ?? "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common";
  const rawUrl = endpoint.startsWith("http") ? endpoint : `${baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  const url = qoderEncodedUrl(rawUrl);
  const plainBody = encoder.encode(JSON.stringify(body));
  const bytes = qoderEncodeBody(plainBody);
  const signed = await buildQoderHeaders(bytes, url, credentials);
  const headers = new Headers(signed);
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream");
  headers.set("cache-control", "no-cache");
  headers.set("accept-encoding", "identity");
  headers.set("x-model-key", context.upstreamModel);
  headers.set("x-model-source", typeof modelConfig.source === "string" ? modelConfig.source : "system");

  return {
    url,
    init: { method: "POST", headers, body: bytes, redirect: "manual" },
    responseMode: "qoder-chat",
  };
}
