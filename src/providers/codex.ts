import type { ProxyRequestContext, UpstreamBuildResult } from "../types";
import { normalizeBaseUrl, sanitizeHeaders } from "../utils";
import { providerAuthHeaders } from "./headers";
import { resolveCodexHttpSessionId } from "./codex-session-continuity";

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content.map((part) => part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? String((part as Record<string, unknown>).text) : "").filter(Boolean).join("\n");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toolOutputImagePart(value: unknown): Record<string, unknown> | undefined {
  const item = record(value);
  const type = item.type;
  if (type === "input_image") {
    const imageUrl = stringValue(item.image_url);
    const fileId = stringValue(item.file_id);
    if (!imageUrl && !fileId) return undefined;
    return {
      type: "input_image",
      ...(imageUrl ? { image_url: imageUrl } : {}),
      ...(fileId ? { file_id: fileId } : {}),
      ...(stringValue(item.detail) ? { detail: item.detail } : {}),
    };
  }
  if (type !== "image_url") return undefined;
  const image = typeof item.image_url === "string" ? { url: item.image_url } : record(item.image_url);
  const imageUrl = stringValue(image.url);
  const fileId = stringValue(image.file_id);
  if (!imageUrl && !fileId) return undefined;
  return {
    type: "input_image",
    ...(imageUrl ? { image_url: imageUrl } : {}),
    ...(fileId ? { file_id: fileId } : {}),
    ...(stringValue(image.detail) ? { detail: image.detail } : {}),
  };
}

function hasToolOutputImagePart(value: unknown): boolean {
  if (typeof value === "string") {
    try { return hasToolOutputImagePart(JSON.parse(value) as unknown); } catch { return false; }
  }
  if (Array.isArray(value)) return value.some((part) => hasToolOutputImagePart(part));
  const item = record(value);
  if (toolOutputImagePart(item)) return true;
  return item.content !== undefined && hasToolOutputImagePart(item.content);
}

function toolOutputFallbackPart(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { type: "input_text", text: value };
  const item = record(value);
  if (typeof item.text === "string") return { type: "input_text", text: item.text };
  let text: string;
  try { text = JSON.stringify(value) ?? String(value); } catch { text = String(value); }
  return { type: "input_text", text };
}

function toolOutputContentPart(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string") {
    try {
      const structured = JSON.parse(value) as unknown;
      if (hasToolOutputImagePart(structured)) return toolOutputContentPart(structured);
    } catch { /* plain string */ }
    return [toolOutputFallbackPart(value)];
  }
  if (Array.isArray(value)) return value.flatMap((part) => toolOutputContentPart(part));
  const item = record(value);
  const image = toolOutputImagePart(item);
  if (image) return [image];
  if ((item.type === "text" || item.type === "input_text" || item.type === "output_text") && typeof item.text === "string") {
    return [{ type: "input_text", text: item.text }];
  }
  if (item.content !== undefined && hasToolOutputImagePart(item.content)) return toolOutputContentPart(item.content);
  return [toolOutputFallbackPart(value)];
}

function toolOutputContent(content: unknown): string | Array<Record<string, unknown>> {
  if (typeof content === "string") {
    try {
      const structured = JSON.parse(content) as unknown;
      if (hasToolOutputImagePart(structured)) return toolOutputContentPart(structured);
    } catch { /* plain string */ }
    return content;
  }
  if (!hasToolOutputImagePart(content)) return contentToText(content);
  return toolOutputContentPart(content);
}

function chatToolsToResponses(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((raw) => {
    const tool = record(raw);
    const fn = record(tool.function);
    if (tool.type !== "function" || !Object.keys(fn).length) return tool;
    const output: Record<string, unknown> = {
      type: "function",
      name: typeof fn.name === "string" ? fn.name : "unknown",
      parameters: record(fn.parameters),
    };
    if (typeof fn.description === "string") output.description = fn.description;
    if (typeof fn.strict === "boolean") output.strict = fn.strict;
    return output;
  });
}

function chatToolChoiceToResponses(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const choice = record(value);
  const fn = record(choice.function);
  if (choice.type === "function" && typeof fn.name === "string") return { type: "function", name: fn.name };
  return value;
}

function codexIdPrefix(item: Record<string, unknown>): string | undefined {
  return item.type === "message" ? "msg"
    : item.type === "reasoning" ? "rs"
      : item.type === "function_call" ? "fc"
        : item.type === "custom_tool_call" ? "ctc"
          : item.type === "custom_tool_call_output" ? "ctco"
            : undefined;
}

function stableIdHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function boundedId(base: string, suffix = ""): string {
  if (!suffix) return base.slice(0, 64);
  return `${base.slice(0, Math.max(1, 64 - suffix.length - 1))}_${suffix}`;
}

export function normalizeCodexInputMessageIds(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const preserved = new Set<string>();
  for (const raw of value) {
    const item = record(raw);
    const prefix = codexIdPrefix(item);
    if (!prefix || typeof item.id !== "string" || !item.id) continue;
    if (item.id.startsWith(`${prefix}_`) && item.id.length <= 64) preserved.add(item.id);
  }
  const occupied = new Set(preserved);
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const item = raw as Record<string, unknown>;
    const prefix = codexIdPrefix(item);
    if (!prefix || typeof item.id !== "string" || item.id.length === 0) return raw;
    if (item.id.startsWith(`${prefix}_`) && item.id.length <= 64) return raw;
    const source = item.id;
    const base = source.startsWith(`${prefix}_`) ? source : `${prefix}_${source}`;
    let id = boundedId(base);
    if (occupied.has(id)) {
      let attempt = 0;
      do {
        const hash = stableIdHash(`${prefix}\0${source}\0${index}\0${attempt}`);
        id = boundedId(base, hash);
        attempt += 1;
      } while (occupied.has(id));
    }
    occupied.add(id);
    return id === item.id ? raw : { ...item, id };
  });
}

function stripNestedPromptCacheBreakpoints(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const item = raw as Record<string, unknown>;
    if (!Array.isArray(item.content)) return raw;
    let changed = false;
    const content = item.content.map((rawPart) => {
      if (!rawPart || typeof rawPart !== "object" || Array.isArray(rawPart)) return rawPart;
      const part = rawPart as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(part, "prompt_cache_breakpoint")) return rawPart;
      const next = { ...part };
      delete next.prompt_cache_breakpoint;
      changed = true;
      return next;
    });
    return changed ? { ...item, content } : raw;
  });
}

export function chatToResponses(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const input: Array<Record<string, unknown>> = [];
  let instructions = typeof body.instructions === "string" ? body.instructions : "";
  if (messages.length === 0 && body.prompt !== undefined) {
    const prompt = Array.isArray(body.prompt) ? body.prompt.map(String).join("\n") : String(body.prompt);
    input.push({ role: "user", content: [{ type: "input_text", text: prompt }] });
  }
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const entry = message as Record<string, unknown>;
    const role = typeof entry.role === "string" ? entry.role : "user";
    if (role === "system" || role === "developer") {
      const text = contentToText(entry.content);
      instructions = instructions ? `${instructions}\n\n${text}` : text;
      continue;
    }
    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: typeof entry.tool_call_id === "string" ? entry.tool_call_id : typeof entry.call_id === "string" ? entry.call_id : "unknown",
        output: toolOutputContent(entry.content),
      });
      continue;
    }
    input.push({ role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text: contentToText(entry.content) }] });
    if (Array.isArray(entry.tool_calls)) {
      for (const rawCall of entry.tool_calls) {
        if (!rawCall || typeof rawCall !== "object") continue;
        const call = rawCall as Record<string, unknown>;
        const fn = call.function && typeof call.function === "object" ? call.function as Record<string, unknown> : {};
        input.push({ type: "function_call", call_id: typeof call.id === "string" ? call.id : crypto.randomUUID(), name: typeof fn.name === "string" ? fn.name : "unknown", arguments: typeof fn.arguments === "string" ? fn.arguments : "{}" });
      }
    }
  }
  const output: Record<string, unknown> = { model, input, stream: body.stream === true, store: false, instructions };
  const tools = chatToolsToResponses(body.tools);
  if (tools) output.tools = tools;
  if (body.tool_choice !== undefined) output.tool_choice = chatToolChoiceToResponses(body.tool_choice);
  if (body.temperature !== undefined) output.temperature = body.temperature;
  if (body.top_p !== undefined) output.top_p = body.top_p;
  if (body.max_completion_tokens !== undefined) output.max_output_tokens = body.max_completion_tokens;
  else if (body.max_tokens !== undefined) output.max_output_tokens = body.max_tokens;
  if (body.reasoning !== undefined) output.reasoning = body.reasoning;
  return output;
}

function normalizeCodexBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const output: Record<string, unknown> = { ...body, model, store: false };
  output.instructions = typeof output.instructions === "string" ? output.instructions : "";
  output.input = normalizeCodexInputMessageIds(stripNestedPromptCacheBreakpoints(output.input));
  delete output.previous_response_id;
  delete output.generate;
  delete output.prompt_cache_retention;
  delete output.prompt_cache_options;
  delete output.safety_identifier;
  const streamOptions = record(output.stream_options);
  const hasReasoningSummaryDelivery = Object.prototype.hasOwnProperty.call(streamOptions, "reasoning_summary_delivery");
  const reasoningSummaryDelivery = streamOptions.reasoning_summary_delivery;
  delete output.stream_options;
  if (hasReasoningSummaryDelivery) output.stream_options = { reasoning_summary_delivery: reasoningSummaryDelivery };
  if ((!Array.isArray(output.tools) || output.tools.length === 0) && output.parallel_tool_calls !== undefined) delete output.parallel_tool_calls;
  return output;
}

export async function buildCodexRequest(context: ProxyRequestContext): Promise<UpstreamBuildResult> {
  const baseUrl = normalizeBaseUrl(context.provider.base_url);
  const headers = sanitizeHeaders(context.originalRequest.headers, context.provider.headers);
  providerAuthHeaders(context.provider, context.credential, context.originalRequest.headers).forEach((value, key) => headers.set(key, value));
  if (!context.credential.secret) headers.delete("authorization");
  headers.set("accept", context.body.stream === true ? "text/event-stream" : "application/json");
  headers.set("content-type", "application/json");
  for (const name of [
    "x-codex-beta-features",
    "x-codex-turn-metadata",
    "x-client-request-id",
    "x-codex-window-id",
    "thread-id",
    "session-id",
    "x-openai-internal-codex-responses-lite",
    "version",
  ]) {
    const value = context.originalRequest.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.delete("session_id");
  const translated = context.endpoint === "responses" ? { ...context.body } : chatToResponses(context.body, context.upstreamModel);
  const body = normalizeCodexBody(translated, context.upstreamModel);
  const sessionId = await resolveCodexHttpSessionId(context.body, context.originalRequest, context.provider.id);
  if (sessionId) {
    body.prompt_cache_key = sessionId;
    headers.set("Session-Id", sessionId);
    headers.set("Conversation_id", sessionId);
  }
  return {
    url: `${baseUrl}${context.provider.endpoints.responses ?? "/responses"}`,
    init: { method: "POST", headers, body: JSON.stringify(body), redirect: "manual" },
    responseMode: context.endpoint === "responses" ? "passthrough" : "codex-chat",
  };
}
