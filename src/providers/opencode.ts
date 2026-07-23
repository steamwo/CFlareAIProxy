import { GatewayError } from "../errors";
import type { GatewayEndpoint, ProviderConfig, ProxyRequestContext, UpstreamBuildResult } from "../types";
import { normalizeBaseUrl, sanitizeHeaders } from "../utils";
import { chatToResponses } from "./codex";
import { providerAuthHeaders } from "./headers";

export type OpenCodeProtocol = "responses" | "anthropic" | "google" | "chat";

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content.map((part) => {
    if (typeof part === "string") return part;
    const item = objectValue(part);
    return typeof item.text === "string" ? item.text : "";
  }).filter(Boolean).join("\n");
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return objectValue(parsed);
  } catch {
    return { value };
  }
}

function absoluteProviderUrl(provider: ProviderConfig, path: string): string {
  const base = normalizeBaseUrl(provider.base_url);
  return path.startsWith("http")
    ? path
    : `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

function endpointUrl(provider: ProviderConfig, key: string, fallback: string): string {
  return absoluteProviderUrl(provider, provider.endpoints[key] ?? fallback);
}

function openCodeHeaders(context: ProxyRequestContext, accept: string): Headers {
  const headers = sanitizeHeaders(context.originalRequest.headers, context.provider.headers);
  const authHeaders = providerAuthHeaders(context.provider, context.credential);
  authHeaders.forEach((value, key) => headers.set(key, value));
  headers.set("content-type", "application/json");
  headers.set("accept", accept);
  headers.set("user-agent", headers.get("user-agent") ?? "CFlareAIProxy/0.5.3");
  return headers;
}

function protocolOverride(provider: ProviderConfig, model: string): OpenCodeProtocol | undefined {
  const exact = objectValue(provider.options.model_protocols)[model];
  if (exact === "responses" || exact === "anthropic" || exact === "google" || exact === "chat") return exact;
  const prefixes = objectValue(provider.options.model_protocol_prefixes);
  for (const [prefix, rawProtocol] of Object.entries(prefixes)) {
    if (!model.startsWith(prefix)) continue;
    if (rawProtocol === "responses" || rawProtocol === "anthropic" || rawProtocol === "google" || rawProtocol === "chat") return rawProtocol;
  }
  return undefined;
}

export function classifyOpenCodeModel(provider: ProviderConfig, model: string): OpenCodeProtocol {
  const overridden = protocolOverride(provider, model);
  if (overridden) return overridden;
  const id = model.toLowerCase();
  if (id.startsWith("gpt-")) return "responses";
  if (id.startsWith("claude-") || id.startsWith("qwen")) return "anthropic";
  if (id.startsWith("gemini-")) return "google";
  return "chat";
}

export function openCodeGatewayEndpoints(provider: ProviderConfig, model: string): GatewayEndpoint[] {
  return classifyOpenCodeModel(provider, model) === "responses" ? ["chat", "responses"] : ["chat"];
}

function anthropicContent(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return content == null ? [] : [{ type: "text", text: String(content) }];
  const output: Array<Record<string, unknown>> = [];
  for (const rawPart of content) {
    if (typeof rawPart === "string") {
      if (rawPart) output.push({ type: "text", text: rawPart });
      continue;
    }
    const part = objectValue(rawPart);
    if ((part.type === "text" || part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") {
      output.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image_url") {
      const image = typeof part.image_url === "string" ? part.image_url : objectValue(part.image_url).url;
      if (typeof image !== "string" || !image) continue;
      const data = image.match(/^data:([^;,]+);base64,(.+)$/i);
      if (data?.[1] && data[2]) {
        output.push({ type: "image", source: { type: "base64", media_type: data[1], data: data[2] } });
      } else {
        output.push({ type: "image", source: { type: "url", url: image } });
      }
    }
  }
  return output;
}

function anthropicTools(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools: Array<Record<string, unknown>> = [];
  for (const rawTool of value) {
    const tool = objectValue(rawTool);
    const fn = objectValue(tool.function);
    if (tool.type !== "function" || typeof fn.name !== "string" || !fn.name) continue;
    const converted: Record<string, unknown> = {
      name: fn.name,
      input_schema: objectValue(fn.parameters),
    };
    if (typeof fn.description === "string") converted.description = fn.description;
    tools.push(converted);
  }
  return tools.length ? tools : undefined;
}

function anthropicToolChoice(value: unknown): Record<string, unknown> | undefined {
  if (value === "auto") return { type: "auto" };
  if (value === "required") return { type: "any" };
  const choice = objectValue(value);
  const fn = objectValue(choice.function);
  if (choice.type === "function" && typeof fn.name === "string") return { type: "tool", name: fn.name };
  return undefined;
}

function chatToAnthropic(body: Record<string, unknown>, model: string, provider: ProviderConfig): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const output: Array<Record<string, unknown>> = [];
  const system: Array<Record<string, unknown>> = [];
  if (messages.length === 0 && body.prompt !== undefined) {
    output.push({ role: "user", content: [{ type: "text", text: textContent(body.prompt) }] });
  }

  for (const rawMessage of messages) {
    const message = objectValue(rawMessage);
    const role = typeof message.role === "string" ? message.role : "user";
    if (role === "system" || role === "developer") {
      const text = textContent(message.content);
      if (text) system.push({ type: "text", text });
      continue;
    }
    if (role === "tool") {
      const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id : crypto.randomUUID();
      output.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolCallId, content: textContent(message.content) }],
      });
      continue;
    }

    const content = anthropicContent(message.content);
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const rawCall of message.tool_calls) {
        const call = objectValue(rawCall);
        const fn = objectValue(call.function);
        const id = typeof call.id === "string" ? call.id : crypto.randomUUID();
        const name = typeof fn.name === "string" ? fn.name : "unknown";
        content.push({ type: "tool_use", id, name, input: parseArguments(fn.arguments) });
      }
    }
    output.push({ role: role === "assistant" ? "assistant" : "user", content });
  }

  const configuredMax = typeof provider.options.max_output_tokens === "number" ? provider.options.max_output_tokens : 32_768;
  const requestedMax = typeof body.max_completion_tokens === "number"
    ? body.max_completion_tokens
    : typeof body.max_tokens === "number" ? body.max_tokens : configuredMax;
  const result: Record<string, unknown> = {
    model,
    messages: output,
    max_tokens: Math.max(1, Math.floor(requestedMax)),
    stream: body.stream === true,
  };
  if (system.length) result.system = system;
  const tools = anthropicTools(body.tools);
  if (tools) result.tools = tools;
  const toolChoice = anthropicToolChoice(body.tool_choice);
  if (toolChoice) result.tool_choice = toolChoice;
  if (typeof body.temperature === "number") result.temperature = body.temperature;
  if (typeof body.top_p === "number") result.top_p = body.top_p;
  if (Array.isArray(body.stop)) result.stop_sequences = body.stop;
  else if (typeof body.stop === "string") result.stop_sequences = [body.stop];
  return result;
}

function googleParts(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return content == null ? [] : [{ text: String(content) }];
  const output: Array<Record<string, unknown>> = [];
  for (const rawPart of content) {
    if (typeof rawPart === "string") {
      if (rawPart) output.push({ text: rawPart });
      continue;
    }
    const part = objectValue(rawPart);
    if ((part.type === "text" || part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") {
      output.push({ text: part.text });
      continue;
    }
    if (part.type === "image_url") {
      const image = typeof part.image_url === "string" ? part.image_url : objectValue(part.image_url).url;
      if (typeof image !== "string") continue;
      const data = image.match(/^data:([^;,]+);base64,(.+)$/i);
      if (data?.[1] && data[2]) output.push({ inlineData: { mimeType: data[1], data: data[2] } });
    }
  }
  return output;
}

function googleTools(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const declarations: Array<Record<string, unknown>> = [];
  for (const rawTool of value) {
    const tool = objectValue(rawTool);
    const fn = objectValue(tool.function);
    if (tool.type !== "function" || typeof fn.name !== "string" || !fn.name) continue;
    const item: Record<string, unknown> = { name: fn.name, parameters: objectValue(fn.parameters) };
    if (typeof fn.description === "string") item.description = fn.description;
    declarations.push(item);
  }
  return declarations.length ? [{ functionDeclarations: declarations }] : undefined;
}

function googleToolConfig(value: unknown): Record<string, unknown> | undefined {
  if (value === "auto") return { functionCallingConfig: { mode: "AUTO" } };
  if (value === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (value === "required") return { functionCallingConfig: { mode: "ANY" } };
  const choice = objectValue(value);
  const fn = objectValue(choice.function);
  if (choice.type === "function" && typeof fn.name === "string") {
    return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [fn.name] } };
  }
  return undefined;
}

function chatToGoogle(body: Record<string, unknown>, provider: ProviderConfig): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const contents: Array<Record<string, unknown>> = [];
  const systemParts: Array<Record<string, unknown>> = [];
  const callNames = new Map<string, string>();

  if (messages.length === 0 && body.prompt !== undefined) contents.push({ role: "user", parts: [{ text: textContent(body.prompt) }] });

  for (const rawMessage of messages) {
    const message = objectValue(rawMessage);
    const role = typeof message.role === "string" ? message.role : "user";
    if (role === "system" || role === "developer") {
      const text = textContent(message.content);
      if (text) systemParts.push({ text });
      continue;
    }
    if (role === "tool") {
      const id = typeof message.tool_call_id === "string" ? message.tool_call_id : "unknown";
      const name = typeof message.name === "string" ? message.name : callNames.get(id) ?? "unknown";
      contents.push({ role: "user", parts: [{ functionResponse: { name, response: { result: textContent(message.content) } } }] });
      continue;
    }
    const parts = googleParts(message.content);
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const rawCall of message.tool_calls) {
        const call = objectValue(rawCall);
        const fn = objectValue(call.function);
        const id = typeof call.id === "string" ? call.id : crypto.randomUUID();
        const name = typeof fn.name === "string" ? fn.name : "unknown";
        callNames.set(id, name);
        parts.push({ functionCall: { name, args: parseArguments(fn.arguments) } });
      }
    }
    contents.push({ role: role === "assistant" ? "model" : "user", parts });
  }

  const result: Record<string, unknown> = { contents };
  if (systemParts.length) result.systemInstruction = { parts: systemParts };
  const tools = googleTools(body.tools);
  if (tools) result.tools = tools;
  const toolConfig = googleToolConfig(body.tool_choice);
  if (toolConfig) result.toolConfig = toolConfig;
  const generationConfig: Record<string, unknown> = {};
  if (typeof body.temperature === "number") generationConfig.temperature = body.temperature;
  if (typeof body.top_p === "number") generationConfig.topP = body.top_p;
  const max = typeof body.max_completion_tokens === "number"
    ? body.max_completion_tokens
    : typeof body.max_tokens === "number"
      ? body.max_tokens
      : typeof provider.options.max_output_tokens === "number" ? provider.options.max_output_tokens : undefined;
  if (typeof max === "number") generationConfig.maxOutputTokens = Math.max(1, Math.floor(max));
  if (typeof body.stop === "string") generationConfig.stopSequences = [body.stop];
  else if (Array.isArray(body.stop)) generationConfig.stopSequences = body.stop;
  if (Object.keys(generationConfig).length) result.generationConfig = generationConfig;
  return result;
}

export function buildOpenCodeRequest(context: ProxyRequestContext): UpstreamBuildResult {
  const protocol = classifyOpenCodeModel(context.provider, context.upstreamModel);
  if (context.endpoint === "responses") {
    if (protocol !== "responses") {
      throw new GatewayError(400, "OPENCODE_RESPONSES_UNSUPPORTED", `${context.upstreamModel} does not use the Responses protocol on OpenCode Zen`, "invalid_request_error");
    }
    const headers = openCodeHeaders(context, context.body.stream === true ? "text/event-stream" : "application/json");
    return {
      url: endpointUrl(context.provider, "responses", "/responses"),
      init: { method: "POST", headers, body: JSON.stringify({ ...context.body, model: context.upstreamModel }), redirect: "manual" },
      responseMode: "passthrough",
    };
  }
  if (context.endpoint !== "chat") {
    throw new GatewayError(400, "OPENCODE_ENDPOINT_UNSUPPORTED", "OpenCode Zen supports /v1/chat/completions for all discovered models and /v1/responses for GPT models", "invalid_request_error");
  }

  if (protocol === "responses") {
    const headers = openCodeHeaders(context, context.body.stream === true ? "text/event-stream" : "application/json");
    return {
      url: endpointUrl(context.provider, "responses", "/responses"),
      init: { method: "POST", headers, body: JSON.stringify(chatToResponses(context.body, context.upstreamModel)), redirect: "manual" },
      responseMode: "codex-chat",
    };
  }
  if (protocol === "anthropic") {
    const headers = openCodeHeaders(context, context.body.stream === true ? "text/event-stream" : "application/json");
    headers.set("anthropic-version", headers.get("anthropic-version") ?? "2023-06-01");
    return {
      url: endpointUrl(context.provider, "messages", "/messages"),
      init: { method: "POST", headers, body: JSON.stringify(chatToAnthropic(context.body, context.upstreamModel, context.provider)), redirect: "manual" },
      responseMode: "anthropic-chat",
    };
  }
  if (protocol === "google") {
    const action = context.body.stream === true ? "streamGenerateContent" : "generateContent";
    const template = context.provider.endpoints.google ?? "/models/{model}:{action}";
    const path = template.replaceAll("{model}", encodeURIComponent(context.upstreamModel)).replaceAll("{action}", action);
    const separator = path.includes("?") ? "&" : "?";
    const url = `${absoluteProviderUrl(context.provider, path)}${context.body.stream === true ? `${separator}alt=sse` : ""}`;
    const headers = openCodeHeaders(context, context.body.stream === true ? "text/event-stream" : "application/json");
    return {
      url,
      init: { method: "POST", headers, body: JSON.stringify(chatToGoogle(context.body, context.provider)), redirect: "manual" },
      responseMode: "google-chat",
    };
  }

  const headers = openCodeHeaders(context, context.body.stream === true ? "text/event-stream" : "application/json");
  return {
    url: endpointUrl(context.provider, "chat", "/chat/completions"),
    init: { method: "POST", headers, body: JSON.stringify({ ...context.body, model: context.upstreamModel }), redirect: "manual" },
    responseMode: "passthrough",
  };
}
