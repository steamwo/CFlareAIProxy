import { describe, expect, it } from "vitest";
import {
  credentialUpdateInvalidatesModelDiscovery,
  deleteCredentialModelDiscovery,
  deleteProviderModelDiscovery,
  providerUpdateInvalidatesModelDiscovery,
} from "./model-discovery-identity";
import type { Env } from "./types";

function recordingEnv(calls: Array<{ query: string; bindings: unknown[] }>): Env {
  return {
    DB: {
      prepare(query: string) {
        let bindings: unknown[] = [];
        return {
          bind(...values: unknown[]) {
            bindings = values;
            return this;
          },
          async run() {
            calls.push({ query, bindings });
            return {};
          },
        };
      },
    },
  } as unknown as Env;
}

describe("model discovery identity invalidation", () => {
  it("invalidates only credential updates that can change upstream identity", () => {
    expect(credentialUpdateInvalidatesModelDiscovery({ label: "renamed", priority: 10 })).toBe(false);
    expect(credentialUpdateInvalidatesModelDiscovery({ secret: "new-key" })).toBe(true);
    expect(credentialUpdateInvalidatesModelDiscovery({ refreshToken: "new-refresh" })).toBe(true);
    expect(credentialUpdateInvalidatesModelDiscovery({ metadata: {} })).toBe(true);
    expect(credentialUpdateInvalidatesModelDiscovery({ secret: "", refreshToken: "" })).toBe(false);
  });

  it("invalidates provider discovery when the normalized base URL or API mode changes", () => {
    expect(providerUpdateInvalidatesModelDiscovery({
      currentBaseUrl: "https://example.com/v1/",
      nextBaseUrl: "https://example.com/v1",
      currentApiMode: "both",
      nextApiMode: "both",
    })).toBe(false);
    expect(providerUpdateInvalidatesModelDiscovery({
      currentBaseUrl: "https://old.example/v1",
      nextBaseUrl: "https://new.example/v1",
      currentApiMode: "both",
      nextApiMode: "both",
    })).toBe(true);
    expect(providerUpdateInvalidatesModelDiscovery({
      currentBaseUrl: "https://example.com/v1",
      nextBaseUrl: "https://example.com/v1",
      currentApiMode: "chat",
      nextApiMode: "responses",
    })).toBe(true);
  });

  it("deletes discovery rows by stable credential or provider identity", async () => {
    const calls: Array<{ query: string; bindings: unknown[] }> = [];
    const env = recordingEnv(calls);
    await deleteCredentialModelDiscovery(env, "credential-1");
    await deleteProviderModelDiscovery(env, "provider-1");
    expect(calls).toEqual([
      { query: "DELETE FROM discovered_models WHERE credential_id=?", bindings: ["credential-1"] },
      { query: "DELETE FROM discovered_models WHERE provider_id=?", bindings: ["provider-1"] },
    ]);
  });
});
