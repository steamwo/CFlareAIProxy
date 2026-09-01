import { describe, expect, it } from "vitest";
import { prepareProviderResponse } from "../src/provider-response";
import type { ProviderResponseContext } from "../src/provider-response";

function qoderEvent(inner: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(inner) })}\n\n`;
}

function upstream(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function context(
  endpoint: ProviderResponseContext["endpoint"],
  response: Response,
  requestedStream: boolean,
  requestId: string,
): ProviderResponseContext {
  return {
    upstream: response,
    mode: "qoder-chat",
    requestedStream,
    model: "Qoder Test",
    requestId,
    providerKind: "qoder",
    endpoint,
  };
}

function ssePayloads(text: string): Array<Record<string, unknown>> {
  return text.split("\n\n").flatMap((block) => {
    const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
    if (!data.length) return [];
    try {
      const payload = JSON.parse(data.join("\n"));
      return payload && typeof payload === "object" && !Array.isArray(payload) ? [payload as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

function nestedInnerError(): string {
  return qoderEvent({ data: { error: { code: "UPSTREAM_FAILURE", message: "nested qoder failure" } } });
}

describe("Qoder source-project response parity", () => {
  it("keeps one Responses text item id through response.completed", async () => {
    const source = qoderEvent({
      choices: [{ delta: { content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    }) + "data: [DONE]\n\n";
    const response = await prepareProviderResponse(context("responses", upstream(source), true, "req-stable-id"));
    const payloads = ssePayloads(await response.text());
    const added = payloads.find((payload) => payload.type === "response.output_item.added" && (payload.item as Record<string, unknown> | undefined)?.type === "message");
    const done = payloads.find((payload) => payload.type === "response.output_item.done" && (payload.item as Record<string, unknown> | undefined)?.type === "message");
    const completed = payloads.find((payload) => payload.type === "response.completed");
    const output = ((completed?.response as Record<string, unknown> | undefined)?.output ?? []) as Array<Record<string, unknown>>;
    const completedMessage = output.find((item) => item.type === "message");
    const addedId = (added?.item as Record<string, unknown> | undefined)?.id;
    expect(addedId).toEqual(expect.any(String));
    expect((done?.item as Record<string, unknown> | undefined)?.id).toBe(addedId);
    expect(completedMessage?.id).toBe(addedId);
  });

  it("treats nested Qoder error objects as buffered upstream errors", async () => {
    await expect(prepareProviderResponse(context(
      "responses",
      upstream(nestedInnerError()),
      false,
      "req-buffered-error",
    ))).rejects.toThrow(/nested qoder failure/);
  });

  it("terminates native Responses and Anthropic streams on nested Qoder errors", async () => {
    const responses = await prepareProviderResponse(context(
      "responses",
      upstream(nestedInnerError()),
      true,
      "req-responses-error",
    ));
    const responsesText = await responses.text();
    expect(responsesText).toContain("event: error");
    expect(responsesText).toContain("nested qoder failure");
    expect(responsesText).not.toContain("event: response.completed");

    const messages = await prepareProviderResponse(context(
      "messages",
      upstream(nestedInnerError()),
      true,
      "req-messages-error",
    ));
    const messagesText = await messages.text();
    expect(messagesText).toContain("event: error");
    expect(messagesText).toContain("nested qoder failure");
    expect(messagesText).not.toContain("event: message_stop");
  });
});
