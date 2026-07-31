import { describe, expect, it } from "vitest";
import { CODEX_CLIENT_VERSION, getBuiltinChannel } from "../builtin-channels";
import type { Credential, ProviderConfig } from "../types";
import { sanitizeHeaders } from "../utils";
import { disableCodexCloaking, providerAuthHeaders } from "./headers";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

function codexProvider(
  options: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): ProviderConfig {
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
    headers_json: JSON.stringify({ ...channel.headers, ...headers }),
    options_json: JSON.stringify({ ...channel.options, ...options }),
    created_at: now,
    updated_at: now,
    endpoints: channel.endpoints,
    auth: channel.auth,
    headers: { ...channel.headers, ...headers },
    options: { ...channel.options, ...options },
  };
}

function credential(metadata: Record<string, unknown> = {}): Credential {
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

function mergedHeaders(
  caller: Record<string, string>,
  provider: ProviderConfig,
  account: Credential,
): Headers {
  const headers = sanitizeHeaders(new Headers(caller), provider.headers);
  providerAuthHeaders(provider, account).forEach((value, key) => headers.set(key, value));
  return headers;
}

describe("Codex compatibility", () => {
  it("matches CLIProxyAPI authorization and model-discovery parameters", () => {
    const channel = getBuiltinChannel("codex");
    expect(channel?.auth.scopes).toEqual(["openid", "email", "profile", "offline_access"]);
    expect(channel?.auth.authorize_param_prompt).toBe("login");
    expect(channel?.auth.authorize_param_id_token_add_organizations).toBe("true");
    expect(channel?.auth.authorize_param_codex_cli_simplified_flow).toBe("true");
    expect(channel?.endpoints.models).toBe(`/models?client_version=${CODEX_CLIENT_VERSION}`);
  });

  it("sends the Codex CLI user agent and account ID from the ID token", () => {
    const idToken = jwt({
      email: "user@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
    });
    const headers = providerAuthHeaders(codexProvider(), credential({ id_token: idToken }));

    expect(headers.get("authorization")).toBe("Bearer access-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("user-agent")).toBe(`codex_cli_rs/${CODEX_CLIENT_VERSION} (Debian 13.0.0; x86_64) WindowsTerminal`);
    expect(headers.get("chatgpt-account-id")).toBe("account-123");
  });

  it("keeps the pinned Codex identity as the backward-compatible default", () => {
    const headers = mergedHeaders(
      { "user-agent": "caller-agent" },
      codexProvider({}, { "user-agent": "provider-agent" }),
      credential(),
    );
    expect(headers.get("user-agent")).toMatch(/^codex_cli_rs\//);
    expect(headers.get("originator")).toBe("codex_cli_rs");
  });

  it("recognizes upstream and local opt-out option spellings", () => {
    expect(disableCodexCloaking(codexProvider({ disable_codex_cloaking: true }))).toBe(true);
    expect(disableCodexCloaking(codexProvider({ disableCodexCloaking: true }))).toBe(true);
    expect(disableCodexCloaking(codexProvider({ codex_preserve_identity_headers: true }))).toBe(true);
    expect(disableCodexCloaking(codexProvider())).toBe(false);
  });

  it("preserves caller identity when cloaking is disabled and no configured identity exists", () => {
    const headers = mergedHeaders(
      { "user-agent": "caller-agent" },
      codexProvider({ disable_codex_cloaking: true }),
      credential(),
    );
    expect(headers.get("user-agent")).toBe("caller-agent");
    expect(headers.get("originator")).toBeNull();
  });

  it("applies credential identity after provider and caller identity", () => {
    const headers = mergedHeaders(
      { "user-agent": "caller-agent" },
      codexProvider(
        { disable_codex_cloaking: true },
        { "user-agent": "provider-agent", originator: "provider-origin" },
      ),
      credential({
        account_id: "account-1",
        headers: {
          "user-agent": "credential-agent",
          originator: "credential-origin",
          authorization: "Bearer attacker-controlled",
          "Chatgpt-Account-Id": "attacker-account",
        },
      }),
    );
    expect(headers.get("user-agent")).toBe("credential-agent");
    expect(headers.get("originator")).toBe("credential-origin");
    expect(headers.get("authorization")).toBe("Bearer access-token");
    expect(headers.get("chatgpt-account-id")).toBe("account-1");
  });

  it("keeps a configured Originator while the default pins User-Agent", () => {
    const headers = providerAuthHeaders(
      codexProvider({}, { "user-agent": "provider-agent", originator: "configured-origin" }),
      credential(),
    );
    expect(headers.get("user-agent")).toMatch(/^codex_cli_rs\//);
    expect(headers.get("originator")).toBe("configured-origin");
  });
});
