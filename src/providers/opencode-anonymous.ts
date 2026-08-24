import type { Credential, CredentialRow } from "../types";

export const OPENCODE_ANONYMOUS_CREDENTIAL_ID = "__opencode_anonymous__";
export const OPENCODE_MODEL_CATALOG_URL = "https://models.opencode.ai/api.json";

export function isOpenCodeAnonymousCredential(id: string): boolean {
  return id === OPENCODE_ANONYMOUS_CREDENTIAL_ID;
}

export function openCodeAnonymousCredentialRow(): CredentialRow {
  return {
    id: OPENCODE_ANONYMOUS_CREDENTIAL_ID,
    provider_id: "opencode",
    label: "OpenCode 匿名免费通道",
    auth_type: "anonymous",
    secret_ciphertext: "",
    refresh_ciphertext: null,
    expires_at: null,
    enabled: 1,
    priority: 1000,
    weight: 1,
    // The public mirror chain is not a scarce account credential. Keep the
    // pool guard high enough that normal concurrent OpenCode sessions do not
    // get rejected as "busy" before mirror failover can run.
    max_concurrency: 1000,
    metadata_json: JSON.stringify({ anonymous: true }),
    last_error: null,
    last_used_at: null,
    created_at: 0,
    updated_at: 0,
  };
}

export function openCodeAnonymousCredential(): Credential {
  return {
    ...openCodeAnonymousCredentialRow(),
    secret: "",
    metadata: { anonymous: true },
  };
}
