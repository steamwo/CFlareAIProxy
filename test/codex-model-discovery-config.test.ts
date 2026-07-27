import { describe, expect, it } from "vitest";
import { BUILTIN_CHANNELS, CODEX_CLIENT_VERSION } from "../src/builtin-channels";
import { providerAuthHeaders } from "../src/providers/headers";
import type { Credential, ProviderConfig } from "../src/types";

const codex = BUILTIN_CHANNELS.find((channel) => channel.id === "codex");

function codexProvider(): ProviderConfig {
  if (!codex) throw new Error("Codex built-in channel is missing");
  return {
    id: codex.id,
    name: codex.name,
    kind: codex.kind,
    base_url: codex.baseUrl,
    enabled: 1,
    pool_strategy: "round_robin",
    endpoints_json: JSON.stringify(codex.endpoints),
    auth_json: JSON.stringify(codex.auth),
    headers_json: JSON.stringify(codex.headers),
    options_json: JSON.stringify(codex.options),
    created_at: 0,
    updated_at: 0,
    endpoints: { ...codex.endpoints },
    auth: { ...codex.auth },
    headers: { ...codex.headers },
    options: { ...codex.options },
  };
}

function codexCredential(): Credential {
  return {
    id: "credential-1",
    provider_id: "codex",
    label: "test",
    auth_type: "oauth",
    secret_ciphertext: "ciphertext",
    refresh_ciphertext: null,
    expires_at: null,
    enabled: 1,
    priority: 100,
    weight: 1,
    max_concurrency: 4,
    metadata_json: "{}",
    last_error: null,
    last_used_at: null,
    created_at: 0,
    updated_at: 0,
    secret: "access-token",
    metadata: { account_id: "account-1" },
  };
}

describe("Codex model discovery configuration", () => {
  it("adds the Codex client_version query parameter to the authenticated models endpoint", () => {
    if (!codex) throw new Error("Codex built-in channel is missing");
    const url = new URL(`${codex.baseUrl}${codex.endpoints.models}`);

    expect(url.origin + url.pathname).toBe("https://chatgpt.com/backend-api/codex/models");
    expect(url.searchParams.get("client_version")).toBe(CODEX_CLIENT_VERSION);
  });

  it("uses the same client version in Codex request headers", () => {
    const headers = providerAuthHeaders(codexProvider(), codexCredential());

    expect(headers.get("authorization")).toBe("Bearer access-token");
    expect(headers.get("originator")).toBe("codex_cli_rs");
    expect(headers.get("user-agent")).toContain(`codex_cli_rs/${CODEX_CLIENT_VERSION}`);
    expect(headers.get("chatgpt-account-id")).toBe("account-1");
  });
});
