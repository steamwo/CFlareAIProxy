import { describe, expect, it } from "vitest";
import { classifyUpstreamResponse } from "../src/upstream-errors";

describe("HTTP 402 credential payment failures", () => {
  it("keeps 402 credential-scoped even when the body says invalid_request_error", () => {
    const result = classifyUpstreamResponse(
      402,
      JSON.stringify({ error: { type: "invalid_request_error", code: "invalid_request_error", message: "Insufficient Balance" } }),
      new Headers({ "retry-after": "2" }),
      "codex",
    );

    expect(result).toMatchObject({
      status: 402,
      code: "PAYMENT_REQUIRED",
      type: "billing_error",
      retryable: true,
      credentialFailure: true,
      providerFailure: false,
      retryAfterMs: 2000,
    });
  });

  it("does not change the existing 429 credential failure precedence", () => {
    const result = classifyUpstreamResponse(
      429,
      JSON.stringify({ error: { type: "invalid_request_error", message: "quota exceeded" } }),
      new Headers(),
      "codex",
    );

    expect(result).toMatchObject({
      status: 429,
      code: "RATE_LIMIT_EXCEEDED",
      retryable: true,
      credentialFailure: true,
      providerFailure: false,
    });
  });

  it("keeps ordinary invalid 400 responses availability-neutral", () => {
    const result = classifyUpstreamResponse(
      400,
      JSON.stringify({ error: { type: "invalid_request_error", message: "bad parameter" } }),
      new Headers(),
      "codex",
    );

    expect(result).toMatchObject({
      status: 400,
      retryable: false,
      credentialFailure: false,
      providerFailure: false,
    });
  });
});
