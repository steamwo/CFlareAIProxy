import { describe, expect, it } from "vitest";
import { handleAnthropicTokenCount } from "../src/anthropic-token-count";
import type { Env } from "../src/types";

describe("Anthropic token count compatibility", () => {
  it("authenticates with GET /v1/models and accepts x-api-key", async () => {
    let authRequest: Request | undefined;
    const worker = {
      async fetch(request: Request) {
        authRequest = request;
        return Response.json({ object: "list", data: [] });
      },
    };
    const request = new Request("https://gateway.example/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "gateway-key" },
      body: JSON.stringify({
        model: "public-model",
        system: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "hello world" }] }],
        tools: [{ name: "lookup", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
      }),
    });

    const response = await handleAnthropicTokenCount(request, { MAX_BODY_BYTES: "1048576" } as Env, {} as ExecutionContext, worker);
    expect(authRequest).toBeDefined();
    expect(authRequest!.method).toBe("GET");
    expect(new URL(authRequest!.url).pathname).toBe("/v1/models");
    expect(authRequest!.headers.get("authorization")).toBe("Bearer gateway-key");
    expect(authRequest!.headers.get("x-api-key")).toBeNull();
    expect(response?.status).toBe(200);
    const payload = await response!.json() as any;
    expect(payload.input_tokens).toBeGreaterThan(0);
  });

  it("maps authentication failures to Anthropic error format", async () => {
    const worker = {
      async fetch() {
        return Response.json({ error: { type: "authentication_error", message: "invalid key" } }, { status: 401 });
      },
    };
    const request = new Request("https://gateway.example/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "bad" },
      body: JSON.stringify({ model: "public-model", messages: [{ role: "user", content: "hello" }] }),
    });

    const response = await handleAnthropicTokenCount(request, {} as Env, {} as ExecutionContext, worker);
    expect(response?.status).toBe(401);
    expect(await response!.json()).toEqual({ type: "error", error: { type: "authentication_error", message: "invalid key" } });
  });
});
