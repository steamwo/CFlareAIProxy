from pathlib import Path

source_path = Path("src/proxy-transport.ts")
source = source_path.read_text()

replacements = {
    'const NATIVE_PROXY_PROTOCOLS = new Set<ProxyProtocol>(["http", "socks", "socks5", "socks5h"]);':
        'const NATIVE_PROXY_PROTOCOLS = new Set<ProxyProtocol>(["http", "socks", "socks4", "socks4a", "socks5", "socks5h"]);',
    '当前原生代理支持 http://、socks5:// 和 socks5h://':
        '当前原生代理支持 http://、socks4://、socks4a://、socks5:// 和 socks5h://',
    '代理协议仅支持 http://、socks5:// 和 socks5h://':
        '代理协议仅支持 http://、socks4://、socks4a://、socks5:// 和 socks5h://',
    ' * Runs one HTTP request through an HTTP CONNECT or SOCKS5 proxy. Every socket':
        ' * Runs one HTTP request through an HTTP CONNECT, SOCKS4/4a, or SOCKS5 proxy. Every socket',
    '    if (protocol === "http" && target.protocol === "https:") await httpConnect(context);\n    else if (protocol !== "http") await socks5Connect(context);':
        '    if (protocol === "http" && target.protocol === "https:") await httpConnect(context);\n    else if (protocol === "socks4" || protocol === "socks4a") await socks4Connect(context, protocol === "socks4a");\n    else if (protocol !== "http") await socks5Connect(context);',
}
for old, new in replacements.items():
    if old not in source:
        raise SystemExit(f"missing source marker: {old}")
    source = source.replace(old, new, 1)

validation_marker = '  if (!url.hostname) throw new GatewayError(400, "PROXY_URL_INVALID", "代理 URL 必须包含主机");\n'
validation_insert = '''  if (!url.hostname) throw new GatewayError(400, "PROXY_URL_INVALID", "代理 URL 必须包含主机");
  if ((protocol === "socks4" || protocol === "socks4a") && url.password) {
    throw new GatewayError(400, "PROXY_URL_INVALID", "SOCKS4/4a 不支持密码认证；URL 用户名仅作为 USERID");
  }
'''
if validation_marker not in source:
    raise SystemExit("missing validation marker")
source = source.replace(validation_marker, validation_insert, 1)

socks5_marker = 'async function socks5Connect(context: TunnelContext): Promise<void> {'
socks4_impl = r'''function parseIpv4(hostname: string): Uint8Array | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number.parseInt(part, 10);
    if (value > 255) return null;
    octets.push(value);
  }
  return new Uint8Array(octets);
}

async function socks4Connect(context: TunnelContext, remoteDns: boolean): Promise<void> {
  const { socket, reader, target, proxy, dialect, idleTimeoutMs } = context;
  const userId = encoder.encode(decodeURIComponent(proxy.username || ""));
  if (userId.byteLength > 255 || userId.includes(0)) throw dialect.proxyCredentialTooLong();

  const port = Number.parseInt(targetPort(target), 10);
  const host = encoder.encode(target.hostname);
  if (host.byteLength === 0 || host.byteLength > 255 || host.includes(0)) throw dialect.hostTooLong();

  let address: Uint8Array;
  let domainSuffix = new Uint8Array();
  if (remoteDns) {
    address = new Uint8Array([0x00, 0x00, 0x00, 0x01]);
    domainSuffix = concatBytes([host, new Uint8Array([0x00])]);
  } else {
    const ipv4 = parseIpv4(target.hostname);
    if (!ipv4) {
      throw new GatewayError(400, "SOCKS4_IPV4_REQUIRED", "socks4:// 仅支持 IPv4 目标；域名目标请使用 socks4a://");
    }
    address = ipv4;
  }

  const request = concatBytes([
    new Uint8Array([0x04, 0x01, (port >> 8) & 0xff, port & 0xff]),
    address,
    userId,
    new Uint8Array([0x00]),
    domainSuffix,
  ]);
  await writeBytes(socket, request, idleTimeoutMs, dialect);

  const reply = await reader.readExact(8);
  if ((reply[0] !== 0x00 && reply[0] !== 0x04) || reply[1] !== 0x5a) {
    throw dialect.socksConnectFailed(reply[1]);
  }
}

'''
if socks5_marker not in source:
    raise SystemExit("missing SOCKS5 marker")
source = source.replace(socks5_marker, socks4_impl + socks5_marker, 1)
source_path.write_text(source)

test_path = Path("test/proxy-socks4.test.ts")
test_path.write_text(r'''import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
''')

docs_path = Path("docs/PROVIDER_PROXY.md")
docs = docs_path.read_text()
docs_replacements = {
    "HTTP CONNECT 与 SOCKS5 代理": "HTTP CONNECT、SOCKS4/4a 与 SOCKS5 代理",
    "http://user:pass@host:port\nsocks5://user:pass@host:port\nsocks5h://user:pass@host:port":
        "http://user:pass@host:port\nsocks4://user@host:port\nsocks4a://user@host:port\nsocks5://user:pass@host:port\nsocks5h://user:pass@host:port",
    "- `socks5h://` 与 `socks5://` 在 Worker 实现中都由代理连接目标主机；建议使用 `socks5h://` 明确表达远端解析意图；":
        "- `socks4://` 只接受 IPv4 目标；`socks4a://` 会把域名交给代理解析；URL 用户名映射为 SOCKS4 USERID，SOCKS4/4a 不支持密码认证；\n- `socks5h://` 与 `socks5://` 在 Worker 实现中都由代理连接目标主机；建议使用 `socks5h://` 明确表达远端解析意图；",
    "socks5h://alice:secret@127.0.0.1:1080":
        "socks4a://alice@127.0.0.1:1080\nsocks5h://alice:secret@127.0.0.1:1080",
    "### SOCKS5 + HTTPS 上游":
        "### SOCKS4/4a + HTTPS 上游\n\n```text\nWorker\n  └─ TCP → SOCKS4/4a Proxy\n       └─ SOCKS4 CONNECT api.example.com:443\n            └─ TLS → api.example.com\n```\n\n### SOCKS5 + HTTPS 上游",
    "HTTP CONNECT 状态、SOCKS5 认证结果":
        "HTTP CONNECT 状态、SOCKS4/4a 返回码、SOCKS5 认证结果",
    "- SOCKS5 不支持所需认证方式；":
        "- SOCKS4/4a 拒绝连接或 SOCKS4 使用了域名目标；\n- SOCKS5 不支持所需认证方式；",
}
for old, new in docs_replacements.items():
    if old not in docs:
        raise SystemExit(f"missing docs marker: {old}")
    docs = docs.replace(old, new, 1)
docs_path.write_text(docs)

for temporary in [
    Path(".github/workflows/agent-socks4-patch.yml"),
    Path(".github/workflows/agent-socks4-pr.yml"),
    Path(".github/scripts/apply-socks4.py"),
]:
    if temporary.exists():
        temporary.unlink()
