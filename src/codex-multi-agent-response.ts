import { restoreCollaborationNamespaceValue } from "./codex-multi-agent-v2";
import { responseEncoder, responseHeaders } from "./response-utils";

function frameData(frame: string): string {
  return frame.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

function replaceFrameData(frame: string, data: string): string {
  const lineEnding = frame.includes("\r\n") ? "\r\n" : "\n";
  const output: string[] = [];
  let replaced = false;
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      output.push(line);
      continue;
    }
    if (!replaced) {
      output.push(`data: ${data}`);
      replaced = true;
    }
  }
  return output.join(lineEnding);
}

function restoreSseFrame(frame: string): string {
  const data = frameData(frame);
  if (!data || data === "[DONE]") return frame;
  try {
    return replaceFrameData(frame, JSON.stringify(restoreCollaborationNamespaceValue(JSON.parse(data))));
  } catch {
    return frame;
  }
}

function transformSseFrames(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let match: RegExpMatchArray | null;
      while ((match = buffer.match(/\r?\n\r?\n/))) {
        const boundary = match.index ?? -1;
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + match[0].length);
        controller.enqueue(responseEncoder.encode(`${restoreSseFrame(frame)}${match[0]}`));
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(responseEncoder.encode(restoreSseFrame(buffer)));
    },
  }));
}

export async function restoreCodexMultiAgentResponse(response: Response, optimized: boolean): Promise<Response> {
  if (!optimized || !response.body) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return new Response(transformSseFrames(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response.headers, contentType),
    });
  }
  const text = await response.text();
  if (!contentType.includes("json")) {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response.headers, contentType || undefined),
    });
  }
  try {
    return Response.json(restoreCollaborationNamespaceValue(JSON.parse(text)), {
      status: response.status,
      headers: responseHeaders(response.headers, "application/json; charset=utf-8"),
    });
  } catch {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response.headers, contentType),
    });
  }
}
