import { describe, expect, it } from "vitest";
import { handleAnthropicTokenCount } from "../src/anthropic-token-count";
import { GatewayError } from "../src/errors";
import type { Env } from "../src/types";

describe("Anthropic token count compatibility", () => {
  it("authorizes the parsed request directly without fetching /v1/models", async () => {
    let authorizationCalls = 0;
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

    const response = await handleAnthropicTokenCount(
      request,
      { MAX_BODY_BYTES: "1048576" } as Env,
      {} as ExecutionContext,
      async (authRequest, _env, body) => {
        authorizationCalls += 1;
        expect(authRequest.headers.get("x-api-key")).toBe("gateway-key");
        expect(body.model).toBe("public-model");
      },
    );

    expect(authorizationCalls).toBe(1);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-cfap-token-count")).toBe("estimated");
    const payload = await response!.json() as any;
    expect(payload.input_tokens).toBeGreaterThan(0);
  });

  it("includes image and document blocks in the estimate instead of treating them as zero", async () => {
    const authorize = async () => undefined;
    const textOnly = await handleAnthropicTokenCount(new Request("https://gateway.example/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key" },
      body: JSON.stringify({ model: "public-model", messages: [{ role: "user", content: "hello" }] }),
    }), {} as Env, {} as ExecutionContext, authorize);
    const multimodal = await handleAnthropicTokenCount(new Request("https://gateway.example/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key" },
      body: JSON.stringify({
        model: "public-model",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
            { type: "document", source: { type: "text", data: "document body" } },
          ],
        }],
      }),
    }), {} as Env, {} as ExecutionContext, authorize);

    const textTokens = (await textOnly!.json() as any).input_tokens;
    const multimodalTokens = (await multimodal!.json() as any).input_tokens;
    expect(multimodalTokens).toBeGreaterThan(textTokens + 1000);
  });

  it("maps authentication failures to Anthropic error format", async () => {
    const request = new Request("https://gateway.example/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "bad" },
      body: JSON.stringify({ model: "public-model", messages: [{ role: "user", content: "hello" }] }),
    });

    const response = await handleAnthropicTokenCount(
      request,
      {} as Env,
      {} as ExecutionContext,
      async () => {
        throw new GatewayError(401, "AUTHENTICATION_ERROR", "invalid key", "authentication_error");
      },
    );
    expect(response?.status).toBe(401);
    expect(await response!.json()).toEqual({ type: "error", error: { type: "authentication_error", message: "invalid key" } });
  });
});
