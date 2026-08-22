import { describe, expect, it } from "vitest";
import { handleAnthropicMessages } from "../src/anthropic-messages-handler";
import type { Env } from "../src/types";
import { readJsonBody } from "../src/utils";

describe("Anthropic Messages routing on dev", () => {
  it("keeps the native messages route when one is available", async () => {
    let nativeBody: Record<string, unknown> | undefined;
    let nativeAuthorization = "";
    let chatCalls = 0;
    const native = {
      async fetch(request: Request) {
        nativeAuthorization = request.headers.get("authorization") ?? "";
        nativeBody = await readJsonBody(request, 1024 * 1024);
        return Response.json({
          id: "msg_native",
          type: "message",
          role: "assistant",
          model: "qoder/model",
          content: [{ type: "text", text: "native" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 2, output_tokens: 1 },
        });
      },
    };
    const chat = {
      async fetch() {
        chatCalls += 1;
        throw new Error("chat fallback should not run");
      },
    };
    const request = new Request("https://gateway.example/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "secret" },
      body: JSON.stringify({
        model: "qoder/model",
        messages: [
          { role: "system", content: "repo instructions" },
          { role: "user", content: "hello" },
        ],
      }),
    });

    const response = await handleAnthropicMessages(
      request,
      {} as Env,
      {} as ExecutionContext,
      native,
      chat,
      async () => true,
    );
    expect(response?.status).toBe(200);
    expect(chatCalls).toBe(0);
    expect(nativeAuthorization).toBe("Bearer secret");
    expect(nativeBody?.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(nativeBody?.system).toEqual([{ type: "text", text: "repo instructions" }]);
    expect((await response!.json() as any).content[0]).toEqual({ type: "text", text: "native" });
  });

  it("dispatches directly to Chat Completions when no native messages route exists", async () => {
    let nativeCalls = 0;
    let chatBody: Record<string, unknown> | undefined;
    const native = {
      async fetch() {
        nativeCalls += 1;
        throw new Error("native messages must not be probed when the route is absent");
      },
    };
    const chat = {
      async fetch(request: Request) {
        chatBody = await readJsonBody(request, 1024 * 1024);
        return Response.json({
          id: "chatcmpl-fallback",
          model: "public-model",
          choices: [{ index: 0, message: { role: "assistant", content: "fallback" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 1,
            total_tokens: 11,
            prompt_tokens_details: { cached_tokens: 8 },
          },
        });
      },
    };
    const request = new Request("https://gateway.example/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: JSON.stringify({
        model: "public-model",
        system: "be concise",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const response = await handleAnthropicMessages(
      request,
      {} as Env,
      {} as ExecutionContext,
      native,
      chat,
      async () => false,
    );
    expect(response?.status).toBe(200);
    expect(nativeCalls).toBe(0);
    expect((chatBody?.messages as any[])[0]).toEqual({ role: "system", content: "be concise" });
    expect((chatBody?.messages as any[])[1]).toEqual({ role: "user", content: "hello" });
    const payload = await response!.json() as any;
    expect(payload.type).toBe("message");
    expect(payload.content[0]).toEqual({ type: "text", text: "fallback" });
    expect(payload.usage).toEqual({ input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 8 });
  });
});
