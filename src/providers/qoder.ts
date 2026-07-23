import type { Env, ProxyRequestContext, UpstreamBuildResult } from "../types";
import { GatewayError } from "../errors";
import { normalizeBaseUrl, parseJson, sha256Hex, truncate } from "../utils";
import { buildQoderHeaders } from "./qoder-crypto";
import { providerFetch } from "../upstream-fetch";

const encoder = new TextEncoder();

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeMessages(messages: unknown): {
  messages: Array<Record<string, unknown>>;
  system: string;
  lastUser: string;
} {
  if (!Array.isArray(messages)) return { messages: [], system: "", lastUser: "" };
  const output: Array<Record<string, unknown>> = [];
  const systemParts: string[] = [];
  let lastUser = "";

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : "user";
    const text = contentToText(message.content);
    if (role === "system" || role === "developer") {
      if (text) systemParts.push(text);
      continue;
    }
    if (role === "user" && text) lastUser = text;
    const normalized: Record<string, unknown> = { ...message, role, content: text };
    output.push(normalized);
  }
  return { messages: output, system: systemParts.join("\n\n"), lastUser };
}

async function stableHash(...parts: unknown[]): Promise<string> {
  return sha256Hex(JSON.stringify(parts));
}

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
  const body = encoder.encode("");
  const signed = await buildQoderHeaders(body, url, credentials);
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
  if (context.endpoint !== "chat") {
    throw new GatewayError(400, "QODER_ENDPOINT_UNSUPPORTED", "Qoder adapter currently supports /v1/chat/completions", "invalid_request_error");
  }
  const credentials = credentialFields(context);
  const normalized = normalizeMessages(context.body.messages);
  const modelConfig = await loadModelConfig(env, context, credentials);
  const maxOutput = typeof modelConfig.max_output_tokens === "number" ? modelConfig.max_output_tokens : 32768;
  const requested = typeof context.body.max_completion_tokens === "number"
    ? context.body.max_completion_tokens
    : typeof context.body.max_tokens === "number"
      ? context.body.max_tokens
      : maxOutput;
  const maxTokens = Math.max(1, Math.min(maxOutput, requested));
  const sessionId = await stableHash("qoder-session", credentials.userId, context.upstreamModel);
  const recordId = await stableHash("qoder-record", context.upstreamModel, normalized.messages, context.body.tools ?? [], maxTokens);
  const body: Record<string, unknown> = {
    request_id: crypto.randomUUID(),
    request_set_id: recordId,
    chat_record_id: recordId,
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
    tools: Array.isArray(context.body.tools) ? context.body.tools : [],
    parameters: { max_tokens: maxTokens },
    chat_context: {
      chatPrompt: "",
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: {
          key: context.upstreamModel,
          is_reasoning: modelConfig.is_reasoning === true,
        },
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
  const url = endpoint.startsWith("http") ? normalizeBaseUrl(endpoint) : `${baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  const bytes = encoder.encode(JSON.stringify(body));
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
