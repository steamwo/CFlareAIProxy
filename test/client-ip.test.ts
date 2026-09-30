import { describe, expect, it } from "vitest";
import { workerClientIp } from "../src/client-ip";

function workerRequest(headers: Record<string, string>): Request {
  const request = new Request("https://example.com/", { headers });
  Object.defineProperty(request, "cf", { value: { colo: "SJC" }, configurable: true });
  return request;
}

describe("workerClientIp", () => {
  it("accepts Cloudflare-provided IPv4 and IPv6 addresses in Worker context", () => {
    expect(workerClientIp(workerRequest({ "cf-connecting-ip": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(workerClientIp(workerRequest({ "cf-connecting-ip": "2001:db8::1" }))).toBe("2001:db8::1");
  });

  it("does not trust forwarded headers or a spoofed CF header outside Worker context", () => {
    expect(workerClientIp(new Request("https://example.com/", {
      headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.9" },
    }))).toBeUndefined();
    expect(workerClientIp(workerRequest({ "x-forwarded-for": "198.51.100.9" }))).toBeUndefined();
  });

  it("rejects multi-hop, whitespace, controls, and malformed IP values", () => {
    for (const value of [
      "203.0.113.7, 198.51.100.9",
      " 203.0.113.7",
      "203.0.113.7 ",
      "999.0.0.1",
      "1.2.3",
      "not-an-ip",
      "2001:db8::zz",
    ]) {
      expect(workerClientIp(workerRequest({ "cf-connecting-ip": value }))).toBeUndefined();
    }
  });
});