import { describe, expect, it, vi } from "vitest";
import { fetchOpenCodeWithFailover, resolveOpenCodeMirrorUrls } from "../src/providers/opencode-failover";
import { openCodeAnonymousCredential } from "../src/providers/opencode-anonymous";
import type { Credential, Env, ProviderConfig } from "../src/types";

function provider(options: Record<string, unknown> = {}): ProviderConfig {
  return {
    id: "opencode",
    name: "OpenCode Zen",
    kind: "opencode",
    base_url: "https://opencode.ai/zen/v1",
    enabled: 1,
    pool_strategy: "round_robin",
    endpoints_json: "{}",
    auth_json: "{}",
    headers_json: "{}",
    options_json: JSON.stringify(options),
    created_at: 0,
    updated_at: 0,
    endpoints: {},
    auth: {},
    headers: {},
    options,
  };
}

function apiKeyCredential(): Credential {
  return {
    id: "key-1",
    provider_id: "opencode",
    label: "key",
    auth_type: "api_key",
    secret_ciphertext: "",
    refresh_ciphertext: null,
    expires_at: null,
    enabled: 1,
    priority: 1,
    weight: 1,
    max_concurrency: 2,
    metadata_json: "{}",
    last_error: null,
    last_used_at: null,
    created_at: 0,
    updated_at: 0,
    secret: "secret-key",
    metadata: {},
  };
}

const env = { OPENCODE_MIRRORS_URL: "https://extra.example/zen/v1" } as unknown as Env;

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

describe("OpenCode failover", () => {
  it("sends anonymous traffic directly through public mirrors", async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("ai.cmliussss.net")) return new Response("busy", { status: 503 });
      return new Response("ok", { status: 200 });
    });

    const result = await fetchOpenCodeWithFailover({
      env,
      provider: provider(),
      credential: openCodeAnonymousCredential(),
      target: "https://opencode.ai/zen/v1/chat/completions",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      fetcher,
      random: () => 0,
    });

    expect(result.usedMirror).toBe(true);
    expect(await result.response.text()).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://opencode.ai.cmliussss.net/zen/v1/chat/completions");
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://opencode.fastly.cmliussss.net/zen/v1/chat/completions");
    expect(header(fetcher.mock.calls[0]![1], "authorization")).toBe("Bearer public");
    expect(header(fetcher.mock.calls[0]![1], "x-opencode-client")).toBe("cli");
    expect(header(fetcher.mock.calls[0]![1], "x-opencode-session")).toMatch(/^ses_/);
  });

  it("tries a configured key before falling back to a public mirror", async () => {
    const fetcher = vi.fn(async (url: string) => (
      url.startsWith("https://opencode.ai/")
        ? new Response("unauthorized", { status: 401 })
        : new Response("ok", { status: 200 })
    ));

    const result = await fetchOpenCodeWithFailover({
      env,
      provider: provider(),
      credential: apiKeyCredential(),
      target: "https://opencode.ai/zen/v1/responses",
      init: { method: "POST", body: "{}" },
      fetcher,
      random: () => 0,
    });

    expect(result.usedMirror).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://opencode.ai/zen/v1/responses");
    expect(header(fetcher.mock.calls[0]![1], "authorization")).toBe("Bearer secret-key");
    expect(header(fetcher.mock.calls[1]![1], "authorization")).toBe("Bearer public");
  });

  it("preserves the official failure after all mirrors fail", async () => {
    const fetcher = vi.fn(async (url: string) => (
      url.startsWith("https://opencode.ai/")
        ? new Response("official failure", { status: 429 })
        : new Response("mirror failure", { status: 503 })
    ));

    const result = await fetchOpenCodeWithFailover({
      env,
      provider: provider(),
      credential: apiKeyCredential(),
      target: "https://opencode.ai/zen/v1/chat/completions",
      init: { method: "POST", body: "{}" },
      fetcher,
      random: () => 0,
    });

    expect(result.usedMirror).toBe(false);
    expect(result.response.status).toBe(429);
    expect(await result.response.text()).toBe("official failure");
  });

  it("deduplicates default, provider, and environment mirror URLs", () => {
    const urls = resolveOpenCodeMirrorUrls(env, provider({
      mirror_urls: ["https://opencode.ai.cmliussss.net/zen/v1/", "https://custom.example/zen/v1"],
    }));

    expect(urls).toEqual([
      "https://opencode.ai.cmliussss.net/zen/v1",
      "https://opencode.fastly.cmliussss.net/zen/v1",
      "https://opencode.gcore.cmliussss.net/zen/v1",
      "https://custom.example/zen/v1",
      "https://extra.example/zen/v1",
    ]);
  });
});
