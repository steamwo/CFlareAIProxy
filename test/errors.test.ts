import { describe, expect, it } from "vitest";
import { GatewayError, normalizeGatewayError } from "../src/errors";

describe("normalizeGatewayError", () => {
  it("preserves explicit gateway errors", () => {
    const error = new GatewayError(400, "BAD_INPUT", "bad input", "invalid_request_error");
    expect(normalizeGatewayError(error)).toBe(error);
  });

  it("identifies an uninitialized D1 schema", () => {
    const error = normalizeGatewayError(new Error("D1_ERROR: no such table: providers: SQLITE_ERROR"));
    expect(error.status).toBe(503);
    expect(error.code).toBe("DATABASE_NOT_INITIALIZED");
    expect(error.type).toBe("configuration_error");
  });

  it("identifies a missing D1 binding", () => {
    const error = normalizeGatewayError(new TypeError("Cannot read properties of undefined (reading 'prepare')"));
    expect(error.status).toBe(503);
    expect(error.code).toBe("DATABASE_BINDING_MISSING");
  });

  it("keeps unknown implementation details private", () => {
    const error = normalizeGatewayError(new Error("unexpected secret detail"));
    expect(error.status).toBe(500);
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.message).toBe("Internal gateway error");
  });
});
