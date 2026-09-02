import { GatewayError } from "./errors";

function sseFrameData(frame: string): string {
  return frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

function sseFrameEvent(frame: string): string {
  return frame
    .split(/\r?\n/)
    .find((line) => line.startsWith("event:"))
    ?.slice(6).trim() ?? "";
}

function eofFrameSeparator(buffer: string): string {
  if (!buffer || buffer.endsWith("\r\n\r\n") || buffer.endsWith("\n\n")) return "";
  if (buffer.endsWith("\r\n") || buffer.endsWith("\n")) return "\n";
  return "\n\n";
}

function frameFailure(frame: string): GatewayError | undefined {
  const event = sseFrameEvent(frame).toLowerCase();
  const data = sseFrameData(frame);
  if (event === "error" || event === "response.error" || event === "response.failed") {
    return new GatewayError(502, "UPSTREAM_STREAM_ERROR", "OpenAI-compatible Responses stream reported an error", "upstream_error");
  }
  if (!data || data === "[DONE]") return undefined;
  try {
    const payload = JSON.parse(data) as Record<string, unknown>;
    const type = typeof payload.type === "string" ? payload.type.toLowerCase() : "";
    if (payload.error !== undefined || type === "error" || type === "response.error" || type === "response.failed") {
      const embedded = payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)
        ? payload.error as Record<string, unknown>
        : {};
      const status = typeof embedded.status === "number" ? embedded.status
        : typeof embedded.status_code === "number" ? embedded.status_code
          : typeof payload.status === "number" ? payload.status : 502;
      const message = typeof embedded.message === "string" ? embedded.message
        : typeof payload.message === "string" ? payload.message
          : "OpenAI-compatible Responses stream reported an error";
      return new GatewayError(status >= 400 && status <= 599 ? status : 502, "UPSTREAM_STREAM_ERROR", message, "upstream_error");
    }
  } catch {
    // Non-JSON data frames remain passthrough-compatible.
  }
  return undefined;
}

export function stopOpenAiCompatibleSseAfterDone(response: Response, requireDone = false): Response {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let done = false;
  let failed = false;

  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (done || failed) return;
      buffer += decoder.decode(chunk, { stream: true });

      while (!done && !failed) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) break;
        const boundary = match.index;
        const end = boundary + match[0].length;
        const frame = buffer.slice(0, boundary);
        const wireFrame = buffer.slice(0, end);
        buffer = buffer.slice(end);

        controller.enqueue(encoder.encode(wireFrame));
        if (sseFrameData(frame).trim() === "[DONE]") {
          done = true;
          buffer = "";
          return;
        }
        if (requireDone) {
          const failure = frameFailure(frame);
          if (failure) {
            failed = true;
            buffer = "";
            controller.error(failure);
            return;
          }
        }
      }
    },
    flush(controller) {
      if (done || failed) return;
      buffer += decoder.decode();
      if (buffer) {
        const finalFrameIsDone = sseFrameData(buffer).trim() === "[DONE]";
        controller.enqueue(encoder.encode(buffer));
        const separator = eofFrameSeparator(buffer);
        if (separator) controller.enqueue(encoder.encode(separator));
        if (finalFrameIsDone) {
          done = true;
          return;
        }
        if (requireDone) {
          const failure = frameFailure(buffer);
          if (failure) {
            failed = true;
            controller.error(failure);
            return;
          }
        }
      }
      if (requireDone) {
        controller.error(new GatewayError(502, "UPSTREAM_STREAM_INCOMPLETE", "OpenAI-compatible Responses stream closed before [DONE]", "upstream_error"));
        return;
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      done = true;
    },
  }));

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
