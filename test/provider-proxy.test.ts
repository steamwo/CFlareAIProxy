import { describe, expect, it } from "vitest";
import {
  hostnameMatchesProxyBypassRule,
  validateProxyUrl,
} from "../src/upstream-fetch";

describe("provider proxy validation", () => {
  it("accepts the supported proxy protocols", () => {
    for (const scheme of ["http", "socks", "socks5", "socks5h"]) {
      expect(validateProxyUrl(`${scheme}://127.0.0.1:1080`).protocol).toBe(`${scheme}:`);
    }
  });

  it("rejects unsupported protocols and incomplete URLs", () => {
    expect(() => validateProxyUrl("ftp://127.0.0.1:21")).toThrow();
    expect(() => validateProxyUrl("https://127.0.0.1:443")).toThrow();
    expect(validateProxyUrl("socks5://127.0.0.1").port).toBe("1080");
  });

  it("matches NO_PROXY entries by exact host or subdomain", () => {
    expect(hostnameMatchesProxyBypassRule("api.example.com", "example.com")).toBe(true);
    expect(hostnameMatchesProxyBypassRule("example.com", ".example.com")).toBe(true);
    expect(hostnameMatchesProxyBypassRule("notexample.com", "example.com")).toBe(false);
    expect(hostnameMatchesProxyBypassRule("anything.invalid", "*")).toBe(true);
    expect(hostnameMatchesProxyBypassRule("api.example.com", "*.example.com")).toBe(true);
    expect(hostnameMatchesProxyBypassRule("127.0.0.1", "127.0.0.1:8787")).toBe(true);
    expect(hostnameMatchesProxyBypassRule("::1", "[::1]:9090")).toBe(true);
  });
});
