import { describe, expect, it } from "vitest";
import { rememberCodexClientIdentity, isOfficialCodexClient } from "./codex-client-identity";
import { prepareCodexResponse } from "./codex-response";

function upstream(...events: Array<Record<string, unknown> | "[DONE]">): Response {
  return new Response(events.map((event) => `data: ${event === "[DONE]" ? event : JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function responseText(requestId: string, request: Request, ...events: Array<Record<string, unknown> | "[DONE]">): Promise<string> {
  rememberCodexClientIdentity(requestId, request);
  const response = await prepareCodexResponse({
    upstream: upstream(...events),
    requestedStream: true,
    model: "gpt-codex",
    requestId,
    endpoint: "responses",
  });
  return response.text();
}

describe("official Codex client stream failure encoding", () => {
  it("recognizes the supported User-Agent and Originator identities", () => {
    expect(isOfficialCodexClient(new Request("https://example.test", { headers: { "user-agent": "Codex Desktop/1.2.3" } }))).toBe(true);
    expect(isOfficialCodexClient(new Request("https://example.test", { headers: { "user-agent": "codex-tui/0.9" } }))).toBe(true);
    expect(isOfficialCodexClient(new Request("https://example.test", { headers: { "user-agent": "codex_cli_rs/1.0" } }))).toBe(true);
    expect(isOfficialCodexClient(new Request("https://example.test", { headers: { originator: "codex_cli_rs" } }))).toBe(true);
    expect(isOfficialCodexClient(new Request("https://example.test", { headers: { "user-agent": "third-party-codex-client/1.0" } }))).toBe(false);
  });

  it("emits response.failed SSE and preserves nested upstream error details", async () => {
    const text = await responseText(
      "request-official-failed",
      new Request("https://example.test", { headers: { "user-agent": "codex-tui/1.0" } }),
      { type: "response.created", sequence_number: 7, response: { id: "resp_1", status: "in_progress", model: "gpt-codex" } },
      { type: "error", error: { type: "invalid_request_error", code: "bad_input", message: "bad request", param: "input", status_code: 400 } },
      "[DONE]",
    );

    expect(text).toContain("event: response.failed\n");
    const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data: {\"type\":\"response.failed\""));
    expect(dataLine).toBeTruthy();
    const payload = JSON.parse(String(dataLine).slice(6)) as Record<string, unknown>;
    expect(payload.sequence_number).toBe(8);
    expect(payload.type).toBe("response.failed");
    expect(payload.response).toEqual({
      status: "failed",
      error: { type: "invalid_request_error", code: "bad_input", message: "bad request", param: "input", status_code: 400 },
    });
    expect(text).not.toContain("data: [DONE]");
  });

  it("preserves response.error from an upstream response.failed event", async () => {
    const text = await responseText(
      "request-upstream-response-failed",
      new Request("https://example.test", { headers: { originator: "Codex Desktop" } }),
      { type: "response.failed", sequence_number: 3, response: { id: "resp_2", error: { type: "server_error", code: "upstream_broke", message: "boom" } } },
    );
    const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data: {\"type\":\"response.failed\""));
    const payload = JSON.parse(String(dataLine).slice(6)) as { sequence_number: number; response: Record<string, unknown> };
    expect(payload.sequence_number).toBe(3);
    expect(payload.response).toMatchObject({
      id: "resp_2",
      status: "failed",
      error: { type: "server_error", code: "upstream_broke", message: "boom" },
    });
  });

  it("keeps legacy error framing for non-Codex clients", async () => {
    const requestId = "request-nonofficial-failed";
    rememberCodexClientIdentity(requestId, new Request("https://example.test", { headers: { "user-agent": "custom-client/1.0" } }));
    const response = await prepareCodexResponse({
      upstream: upstream({ type: "error", error: { type: "invalid_request_error", code: "bad", message: "bad", status_code: 400 } }),
      requestedStream: true,
      model: "gpt-codex",
      requestId,
      endpoint: "responses",
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain('data: {"error":');
    await expect(reader.read()).rejects.toBeTruthy();
  });
});
