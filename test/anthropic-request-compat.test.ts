import { describe, expect, it } from "vitest";
import { handleAnthropicMessages } from "../src/anthropic-messages-handler";
import { normalizeClaudeCodeMessagesBody } from "../src/anthropic-request-compat";
import type { Env } from "../src/types";
import { readJsonBody } from "../src/utils";

describe("Claude Code Anthropic request compatibility", () => {
  it("moves only leading messages[].role=system into the top-level system field", () => {
    const original = {
      model: "public-model",
      system: "base instruction",
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "Claude Code reminder", cache_control: { type: "ephemeral" } },
          ],
        },
        { role: "user", content: "hello" },
      ],
    };

    const body = normalizeClaudeCodeMessagesBody(original);

    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(body.system).toEqual([
      { type: "text", text: "base instruction" },
      { type: "text", text: "Claude Code reminder", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("keeps a mid-conversation system instruction at its original position", () => {
    const body = normalizeClaudeCodeMessagesBody({
      model: "public-model",
      system: "base",
      messages: [
        { role: "user", content: "first turn" },
        { role: "system", content: [{ type: "text", text: "new operator instruction" }] },
        { role: "assistant", content: "ack" },
      ],
    });

    expect(body.system).toEqual([{ type: "text", text: "base" }]);
    expect(body.messages).toEqual([
      { role: "user", content: "first turn" },
      {
        role: "user",
        content: [{ type: "text", text: "<system-reminder>\nnew operator instruction\n</system-reminder>" }],
      },
      { role: "assistant", content: "ack" },
    ]);
  });

  it("forwards a Claude Code fallback request through the cached internal JSON body path", async () => {
    let forwarded: Request | undefined;
    let forwardedBody: Record<string, unknown> | undefined;
    let nativeCalls = 0;
    const native = {
      async fetch() {
        nativeCalls += 1;
        throw new Error("native route must not be probed for a chat-only model");
      },
    };
    const chat = {
      async fetch(request: Request) {
        forwarded = request;
        forwardedBody = await readJsonBody(request, 1024 * 1024);
        return Response.json({
          id: "chatcmpl-system",
          model: "public-model",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        });
      },
    };
    const request = new Request("https://gateway.example/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "secret" },
      body: JSON.stringify({
        model: "public-model",
        messages: [
          { role: "system", content: "Use the repository instructions." },
          { role: "user", content: "reply ok" },
        ],
      }),
    });

    const response = await handleAnthropicMessages(
      request,
      { MAX_BODY_BYTES: "1048576" } as Env,
      {} as ExecutionContext,
      native,
      chat,
      async () => false,
    );

    expect(response?.status).toBe(200);
    expect(nativeCalls).toBe(0);
    expect(forwarded).toBeDefined();
    expect(forwarded!.url).toBe("https://gateway.example/v1/chat/completions");
    expect(forwarded!.headers.get("authorization")).toBe("Bearer secret");
    expect(forwarded!.headers.get("x-api-key")).toBeNull();
    expect(forwarded!.body).toBeNull();
    expect(forwardedBody).toBeDefined();
    const chatMessages = forwardedBody!.messages as Array<Record<string, unknown>>;
    expect(chatMessages[0]).toEqual({ role: "system", content: "Use the repository instructions." });
    expect(chatMessages[1]).toEqual({ role: "user", content: "reply ok" });
    const payload = await response!.json() as any;
    expect(payload.content[0]).toEqual({ type: "text", text: "ok" });
  });

  it("does not clone or rewrite ordinary Anthropic bodies without embedded system messages", () => {
    const body = { model: "public-model", messages: [{ role: "user", content: "hello" }] };
    expect(normalizeClaudeCodeMessagesBody(body)).toBe(body);
  });
});
