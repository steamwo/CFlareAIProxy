function sseFrameData(frame: string): string {
  return frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

export function stopOpenAiCompatibleSseAfterDone(response: Response): Response {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let done = false;

  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (done) return;
      buffer += decoder.decode(chunk, { stream: true });

      while (!done) {
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
        }
      }
    },
    flush(controller) {
      if (done) return;
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(buffer));
    },
  }));

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
