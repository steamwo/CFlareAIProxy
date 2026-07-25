import type { ProxyRequestContext, UpstreamBuildResult } from "../types";
import { normalizeBaseUrl, sanitizeHeaders } from "../utils";
import { providerAuthHeaders } from "./headers";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value == null ? "" : String(value);
  return value.map((entry) => typeof entry === "string" ? entry : typeof record(entry).text === "string" ? String(record(entry).text) : "").filter(Boolean).join("\n");
}

function isEmptyAssistantContent(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (entry == null) return true;
    if (typeof entry === "string") return entry.trim() === "";
    const row = record(entry);
    return typeof row.text === "string" ? row.text.trim() === "" : Object.keys(row).length === 0;
  });
}

export function normalizeKimiMessages(messages: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(messages)) return [];
  const output: Array<Record<string, unknown>> = [];
  const pending: string[] = [];
  let latestReasoning = "";

  for (const raw of messages) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const message = { ...(raw as Record<string, unknown>) };
    const role = typeof message.role === "string" ? message.role.trim() : "";
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const functionCall = record(message.function_call);
    const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content.trim() : "";

    if (role === "assistant" && isEmptyAssistantContent(message.content) && toolCalls.length === 0
      && Object.keys(functionCall).length === 0 && !reasoning) continue;

    if (role === "assistant") {
      if (reasoning) latestReasoning = reasoning;
      if (toolCalls.length > 0) {
        if (!reasoning) message.reasoning_content = latestReasoning || contentText(message.content).trim() || "[reasoning unavailable]";
        for (const rawCall of toolCalls) {
          const id = typeof record(rawCall).id === "string" ? String(record(rawCall).id).trim() : "";
          if (id) pending.push(id);
        }
      }
    } else if (role === "tool") {
      let id = typeof message.tool_call_id === "string" ? message.tool_call_id.trim() : "";
      if (!id && typeof message.call_id === "string") id = message.call_id.trim();
      if (!id && pending.length === 1) id = pending[0]!;
      if (id) {
        message.tool_call_id = id;
        const index = pending.indexOf(id);
        if (index >= 0) pending.splice(index, 1);
      }
    }
    output.push(message);
  }
  return output;
}

function responsesContentToChat(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((raw) => {
    const part = record(raw);
    const type = typeof part.type === "string" ? part.type : "";
    if ((type === "input_text" || type === "output_text") && typeof part.text === "string") {
      return { type: "text", text: part.text };
    }
    if (type === "input_image") {
      const image = part.image_url ?? part.image;
      if (typeof image === "string") return { type: "image_url", image_url: { url: image } };
      if (image && typeof image === "object" && !Array.isArray(image)) return { type: "image_url", image_url: image };
    }
    return part;
  });
}

function responsesToolChoiceToChat(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const choice = record(value);
  if (choice.type === "function" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  return value;
}

function responsesInputToMessages(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) messages.push({ role: "system", content: body.instructions });
  const input = body.input;
  if (typeof input === "string") messages.push({ role: "user", content: input });
  else if (Array.isArray(input)) {
    for (const raw of input) {
      if (typeof raw === "string") { messages.push({ role: "user", content: raw }); continue; }
      const item = record(raw);
      const type = typeof item.type === "string" ? item.type : "";
      if (type === "function_call_output" || type === "custom_tool_call_output") {
        messages.push({ role: "tool", tool_call_id: item.call_id, content: item.output ?? "" });
      } else if (type === "function_call" || type === "custom_tool_call") {
        messages.push({ role: "assistant", content: null, tool_calls: [{ id: item.call_id ?? item.id, type: "function", function: { name: item.name ?? "unknown", arguments: item.arguments ?? "{}" } }] });
      } else {
        messages.push({ role: typeof item.role === "string" ? item.role : "user", content: responsesContentToChat(item.content ?? item.text ?? "") });
      }
    }
  }
  return messages;
}

function responsesToolsToChat(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((raw) => {
    const tool = record(raw);
    if (tool.type === "function" && tool.function && typeof tool.function === "object") return tool;
    if (tool.type === "function") {
      return { type: "function", function: { name: tool.name ?? "unknown", description: tool.description, parameters: tool.parameters ?? {} } };
    }
    return tool;
  });
}

function requestBody(context: ProxyRequestContext): Record<string, unknown> {
  const source = context.body;
  let body: Record<string, unknown>;
  if (context.endpoint === "responses") {
    body = {
      messages: responsesInputToMessages(source),
      stream: source.stream === true,
    };
    const tools = responsesToolsToChat(source.tools);
    if (tools) body.tools = tools;
    if (source.tool_choice !== undefined) body.tool_choice = responsesToolChoiceToChat(source.tool_choice);
    if (source.temperature !== undefined) body.temperature = source.temperature;
    if (source.top_p !== undefined) body.top_p = source.top_p;
    if (source.max_output_tokens !== undefined) body.max_tokens = source.max_output_tokens;
    if (source.reasoning !== undefined) body.reasoning = source.reasoning;
  } else if (context.endpoint === "completions") {
    const prompt = Array.isArray(source.prompt) ? source.prompt.map(String).join("\n") : String(source.prompt ?? "");
    body = { ...source, messages: [{ role: "user", content: prompt }] };
    delete body.prompt;
  } else {
    body = { ...source };
  }
  const defaults = record(context.provider.options.request_defaults);
  const overrides = record(context.provider.options.request_overrides);
  for (const [key, value] of Object.entries(defaults)) if (body[key] === undefined) body[key] = value;
  Object.assign(body, overrides);
  body.model = context.upstreamModel.replace(/\[1m\]$/i, "");
  body.messages = normalizeKimiMessages(body.messages);
  if (body.stream === true) {
    const streamOptions = record(body.stream_options);
    body.stream_options = { ...streamOptions, include_usage: true };
  }
  return body;
}

export function buildKimiRequest(context: ProxyRequestContext): UpstreamBuildResult {
  const baseUrl = normalizeBaseUrl(context.provider.base_url);
  const endpoint = context.provider.endpoints.chat ?? "/chat/completions";
  const headers = sanitizeHeaders(context.originalRequest.headers, context.provider.headers);
  providerAuthHeaders(context.provider, context.credential).forEach((value, key) => headers.set(key, value));
  headers.set("content-type", "application/json");
  headers.set("accept", context.body.stream === true ? "text/event-stream" : "application/json");
  headers.set("x-msh-platform", headers.get("x-msh-platform") ?? "CFlareAIProxy");
  headers.set("x-msh-version", headers.get("x-msh-version") ?? "0.5.3");
  headers.set("x-msh-device-name", headers.get("x-msh-device-name") ?? "cloudflare-worker");
  headers.set("x-msh-device-model", headers.get("x-msh-device-model") ?? "Cloudflare Workers");
  const deviceId = typeof context.credential.metadata.device_id === "string" ? context.credential.metadata.device_id : context.credential.id;
  headers.set("x-msh-device-id", headers.get("x-msh-device-id") ?? deviceId);
  const url = endpoint.startsWith("http") ? endpoint : `${baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  return {
    url,
    init: { method: "POST", headers, body: JSON.stringify(requestBody(context)), redirect: "manual" },
    responseMode: context.endpoint === "chat" ? "passthrough" : "codex-chat",
  };
}
