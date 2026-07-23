import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode, parseJson, timingSafeEqualText } from "../src/utils";

describe("utils", () => {
  it("round-trips base64url", () => {
    const input = new TextEncoder().encode("CFlareAIProxy ✓");
    expect(new TextDecoder().decode(base64UrlDecode(base64UrlEncode(input)))).toBe("CFlareAIProxy ✓");
  });
  it("uses safe JSON fallback", () => expect(parseJson("{bad", { ok: true })).toEqual({ ok: true }));
  it("compares text without early length exit", () => {
    expect(timingSafeEqualText("abc", "abc")).toBe(true);
    expect(timingSafeEqualText("abc", "abd")).toBe(false);
    expect(timingSafeEqualText("abc", "abcx")).toBe(false);
  });
});
