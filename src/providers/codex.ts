import type { ProxyRequestContext, UpstreamBuildResult } from "../types";
import { normalizeBaseUrl, sanitizeHeaders } from "../utils";
import { providerAuthHeaders } from "./headers";

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content.map((part) => part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? String((part as Record<string, unknown>).text) : "").filter(Boolean).join("\n");
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
      input.push({ type: "function_call_output", call_id: typeof entry.tool_call_id === "string" ? entry.tool_call_id : typeof entry.call_id === "string" ? entry.call_id : "unknown", output: contentToText(entry.content) });
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
  if (Array.isArray(body.tools)) output.tools = body.tools;
  if (body.tool_choice !== undefined) output.tool_choice = body.tool_choice;
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
  delete output.previous_response_id;
  delete output.generate;
  delete output.prompt_cache_retention;
  delete output.safety_identifier;
  delete output.stream_options;
  if ((!Array.isArray(output.tools) || output.tools.length === 0) && output.parallel_tool_calls !== undefined) delete output.parallel_tool_calls;
  return output;
}

export function buildCodexRequest(context: ProxyRequestContext): UpstreamBuildResult {
  const baseUrl = normalizeBaseUrl(context.provider.base_url);
  const headers = sanitizeHeaders(context.originalRequest.headers, context.provider.headers);
  providerAuthHeaders(context.provider, context.credential).forEach((value, key) => headers.set(key, value));
  headers.set("accept", context.body.stream === true ? "text/event-stream" : "application/json");
  headers.set("content-type", "application/json");
  for (const name of ["x-codex-beta-features", "x-codex-turn-metadata", "x-client-request-id", "session_id", "version"]) {
    const value = context.originalRequest.headers.get(name);
    if (value) headers.set(name, value);
  }
  const translated = context.endpoint === "responses" ? { ...context.body } : chatToResponses(context.body, context.upstreamModel);
  const body = normalizeCodexBody(translated, context.upstreamModel);
  return {
    url: `${baseUrl}${context.provider.endpoints.responses ?? "/responses"}`,
    init: { method: "POST", headers, body: JSON.stringify(body), redirect: "manual" },
    responseMode: context.endpoint === "responses" ? "passthrough" : "codex-chat",
  };
}
