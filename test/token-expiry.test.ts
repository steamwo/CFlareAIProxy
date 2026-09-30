import { describe, expect, it } from "vitest";
import { credentialAccessTokenExpiry, credentialAccessTokenUsable, credentialNeedsRefresh, jwtAccessTokenExpiry } from "../src/token-expiry";

function jwt(exp: unknown): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${encode({ alg: "none" })}.${encode({ exp })}.sig`;
}

describe("access token expiry resolution", () => {
  it("prefers a valid JWT exp over persisted metadata", () => {
    const token = jwt(2_000_000_000);
    expect(jwtAccessTokenExpiry(token)).toBe(2_000_000_000);
    expect(credentialAccessTokenExpiry({ secret: token, expires_at: 1_900_000_000 })).toBe(2_000_000_000);
    expect(credentialAccessTokenExpiry({ secret: token, expires_at: 2_100_000_000 })).toBe(2_000_000_000);
  });

  it("falls back when JWT exp is absent, malformed, fractional, or unsafe", () => {
    for (const token of ["not-a-jwt", jwt(undefined), jwt(1.5), jwt(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(credentialAccessTokenExpiry({ secret: token, expires_at: 1_900_000_000 })).toBe(1_900_000_000);
    }
  });

  it("treats unknown expiry as usable but explicit expiry as authoritative", () => {
    expect(credentialAccessTokenUsable({ secret: "opaque", expires_at: null }, 100)).toBe(true);
    expect(credentialAccessTokenUsable({ secret: jwt(100), expires_at: 999 }, 100)).toBe(false);
    expect(credentialAccessTokenUsable({ secret: jwt(101), expires_at: 1 }, 100)).toBe(true);
  });

  it("uses the resolved expiry for proactive refresh decisions", () => {
    expect(credentialNeedsRefresh({ secret: jwt(1_000), expires_at: 10_000 }, 100, 950)).toBe(true);
    expect(credentialNeedsRefresh({ secret: jwt(2_000), expires_at: 1 }, 100, 950)).toBe(false);
  });
});