import { describe, expect, it } from "vitest";
import { getBuiltinChannel } from "../builtin-channels";
import type { Credential, ProviderConfig } from "../types";
import { providerAuthHeaders } from "./headers";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

function codexProvider(): ProviderConfig {
  const channel = getBuiltinChannel("codex");
  if (!channel) throw new Error("missing codex channel");
  const now = Math.floor(Date.now() / 1000);
  return {
    id: channel.id,
    name: channel.name,
    kind: channel.kind,
    base_url: channel.baseUrl,
    enabled: 1,
    pool_strategy: "round_robin",
    endpoints_json: JSON.stringify(channel.endpoints),
    auth_json: JSON.stringify(channel.auth),
    headers_json: JSON.stringify(channel.headers),
    options_json: JSON.stringify(channel.options),
    created_at: now,
    updated_at: now,
    endpoints: channel.endpoints,
    auth: channel.auth,
    headers: channel.headers,
    options: channel.options,
  };
}

function credential(metadata: Record<string, unknown>): Credential {
  return {
    id: "codex-test",
    provider_id: "codex",
    label: "Codex test",
    auth_type: "oauth",
    secret_ciphertext: "",
    refresh_ciphertext: null,
    expires_at: null,
    enabled: 1,
    priority: 100,
    weight: 1,
    max_concurrency: 4,
    metadata_json: JSON.stringify(metadata),
    last_error: null,
    last_used_at: null,
    created_at: 0,
    updated_at: 0,
    secret: "access-token",
    metadata,
  };
}

describe("Codex compatibility", () => {
  it("matches CLIProxyAPI authorization parameters", () => {
    const channel = getBuiltinChannel("codex");
    expect(channel?.auth.scopes).toEqual(["openid", "email", "profile", "offline_access"]);
    expect(channel?.auth.authorize_param_prompt).toBe("login");
    expect(channel?.auth.authorize_param_id_token_add_organizations).toBe("true");
    expect(channel?.auth.authorize_param_codex_cli_simplified_flow).toBe("true");
  });

  it("sends the Codex CLI user agent and account ID from the ID token", () => {
    const idToken = jwt({
      email: "user@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
    });
    const headers = providerAuthHeaders(codexProvider(), credential({ id_token: idToken }));

    expect(headers.get("authorization")).toBe("Bearer access-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("user-agent")).toBe("codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal");
    expect(headers.get("chatgpt-account-id")).toBe("account-123");
  });
});
