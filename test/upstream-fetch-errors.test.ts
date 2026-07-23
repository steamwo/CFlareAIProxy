import { describe, expect, it } from "vitest";
import { GatewayError } from "../src/errors";
import { isTlsHandshakeFailure } from "../src/upstream-fetch";

describe("proxy TLS diagnostics", () => {
  it("recognizes the Workers TLS handshake error", () => {
    expect(isTlsHandshakeFailure(new Error("TLS Handshake Failed."))).toBe(true);
  });

  it("recognizes the normalized proxy TLS error code", () => {
    expect(isTlsHandshakeFailure(new GatewayError(502, "PROXY_TLS_HANDSHAKE_FAILED", "tunnel failed"))).toBe(true);
  });

  it("does not classify ordinary proxy failures as TLS errors", () => {
    expect(isTlsHandshakeFailure(new GatewayError(504, "PROXY_CONNECT_TIMEOUT", "connect timeout"))).toBe(false);
  });
});
