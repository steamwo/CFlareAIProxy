import { describe, expect, it } from "vitest";
import { prepareCodexResponse } from "./codex-response";

function sse(...events: Array<Record<string, unknown> | "[DONE]">): Response {
  const body = events.map((event) => `data: ${event === "[DONE]" ? event : JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function context(upstream: Response, forceResponseModelMapping = false) {
  return {
    upstream,
    requestedStream: true,
    model: "client-public-model",
    requestId: "request-response-model",
    endpoint: "responses" as const,
    forceResponseModelMapping,
  };
}

async function responseEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split(/\r?\n\r?\n/)
    .map((frame) => frame.startsWith("data: ") ? frame.slice(6) : "")
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

function responseModel(event: Record<string, unknown>): unknown {
  return (event.response as Record<string, unknown> | undefined)?.model;
}

describe("Codex Responses start-event model fallback", () => {
  it("fills missing or blank model on response.created and response.in_progress", async () => {
    const events = await responseEvents(await prepareCodexResponse(context(sse(
      { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
      { type: "response.in_progress", response: { id: "resp_1", status: "in_progress", model: "  " } },
      { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } },
      "[DONE]",
    ))));

    expect(responseModel(events.find((event) => event.type === "response.created") ?? {})).toBe("client-public-model");
    expect(responseModel(events.find((event) => event.type === "response.in_progress") ?? {})).toBe("client-public-model");
  });

  it("preserves an upstream start-event model by default", async () => {
    const events = await responseEvents(await prepareCodexResponse(context(sse(
      { type: "response.created", response: { id: "resp_1", model: "upstream-model" } },
      { type: "response.in_progress", response: { id: "resp_1", model: "upstream-model" } },
      { type: "response.completed", response: { id: "resp_1", model: "terminal-model", output: [] } },
      "[DONE]",
    ))));

    expect(responseModel(events.find((event) => event.type === "response.created") ?? {})).toBe("upstream-model");
    expect(responseModel(events.find((event) => event.type === "response.in_progress") ?? {})).toBe("upstream-model");
    expect(responseModel(events.find((event) => event.type === "response.completed") ?? {})).toBe("terminal-model");
  });

  it("keeps forceResponseModelMapping as an explicit stronger override", async () => {
    const events = await responseEvents(await prepareCodexResponse(context(sse(
      { type: "response.created", response: { id: "resp_1", model: "upstream-created" } },
      { type: "response.in_progress", response: { id: "resp_1", model: "upstream-progress" } },
      { type: "response.completed", response: { id: "resp_1", model: "upstream-completed", output: [] } },
      "[DONE]",
    ), true)));

    for (const event of events) expect(responseModel(event)).toBe("client-public-model");
  });

  it("does not add model fields to unrelated response events", async () => {
    const events = await responseEvents(await prepareCodexResponse(context(sse(
      { type: "response.output_item.added", output_index: 0, response: { id: "resp_1" }, item: { type: "message", content: [] } },
      { type: "response.completed", response: { id: "resp_1", output: [] } },
      "[DONE]",
    ))));

    const added = events.find((event) => event.type === "response.output_item.added") ?? {};
    expect(responseModel(added)).toBeUndefined();
  });
});
