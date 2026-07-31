import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { providerFetchForCredential } from "../src/credential-fetch";
import { validateProxyUrl } from "../src/proxy-transport";
import type { Credential, Env, ProviderConfig } from "../src/types";
import { enqueueSocket, recordedSockets, resetSockets } from "./mocks/cloudflare-sockets";

const encoder = new TextEncoder();

function credential(proxyUrl: string): Credential {
  return { metadata: { proxy_url: proxyUrl } } as unknown as Credential;
}

const provider = {
  id: "provider-1",
  name: "Provider",
  kind: "openai-compatible",
  base_url: "http://upstream.test/v1",
  endpoints: {},
  auth: {},
  headers: {},
  options: {},
} as unknown as ProviderConfig;

const env = {} as Env;

beforeEach(() => resetSockets());
afterEach(() => resetSockets());

describe("SOCKS4 proxy URLs", () => {
  it("accepts SOCKS4 and SOCKS4a with the standard default port", () => {
    expect(validateProxyUrl("socks4://127.0.0.1").port).toBe("1080");
    expect(validateProxyUrl("socks4a://proxy.example").port).toBe("1080");
  });

  it("rejects password authentication because SOCKS4 only carries USERID", () => {
    expect(() => validateProxyUrl("socks4://user:secret@127.0.0.1:1080"))
      .toThrowError(expect.objectContaining({ code: "PROXY_URL_INVALID", status: 400 }));
  });
});

describe("SOCKS4 proxy handshake", () => {
  it("encodes an IPv4 target and URL username as USERID", async () => {
    enqueueSocket({
      steps: [
        { type: "awaitWrite", count: 1 },
        { type: "data", bytes: new Uint8Array([0x00, 0x5a, 0x00, 0x50, 0, 0, 0, 0]) },
        { type: "awaitWrite", count: 2 },
        { type: "data", bytes: "HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nhi" },
      ],
    });

    const response = await providerFetchForCredential(
      env,
      provider,
      credential("socks4://alice@127.0.0.1:1080"),
      "http://192.0.2.10/v1/models",
      { method: "GET" },
      { timeoutMs: 120_000 },
    );

    expect(await response.text()).toBe("hi");
    expect(Array.from(recordedSockets()[0]?.writes[0] ?? [])).toEqual([
      0x04, 0x01, 0x00, 0x50, 192, 0, 2, 10, ...encoder.encode("alice"), 0x00,
    ]);
  });

  it("encodes a SOCKS4a domain after the USERID terminator", async () => {
    const host = "upstream.test";
    enqueueSocket({
      steps: [
        { type: "awaitWrite", count: 1 },
        { type: "data", bytes: new Uint8Array([0x00, 0x5a, 0x00, 0x50, 0, 0, 0, 0]) },
        { type: "awaitWrite", count: 2 },
        { type: "data", bytes: "HTTP/1.1 204 No Content\r\n\r\n" },
      ],
    });

    const response = await providerFetchForCredential(
      env,
      provider,
      credential("socks4a://alice@127.0.0.1:1080"),
      `http://${host}/v1/models`,
      { method: "GET" },
      { timeoutMs: 120_000 },
    );

    expect(response.status).toBe(204);
    expect(Array.from(recordedSockets()[0]?.writes[0] ?? [])).toEqual([
      0x04, 0x01, 0x00, 0x50, 0, 0, 0, 1,
      ...encoder.encode("alice"), 0x00,
      ...encoder.encode(host), 0x00,
    ]);
  });

  it("requires SOCKS4a for domain targets", async () => {
    enqueueSocket({ steps: [] });
    await expect(providerFetchForCredential(
      env,
      provider,
      credential("socks4://127.0.0.1:1080"),
      "http://upstream.test/v1/models",
      { method: "GET" },
      { timeoutMs: 120_000 },
    )).rejects.toMatchObject({ code: "SOCKS4_IPV4_REQUIRED", status: 400 });
  });
});
