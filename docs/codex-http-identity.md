# Codex HTTP identity headers

CFlareAIProxy keeps its existing Codex-compatible HTTP identity by default:

- `User-Agent` is pinned to the configured `codex_client_version` or the built-in Codex client version.
- `Originator` defaults to `codex_cli_rs` when no provider or credential value is configured.
- `Authorization` and `Chatgpt-Account-Id` are always derived from the selected credential and cannot be overridden by caller or credential metadata headers.

Set one of the following provider options to `true` to disable the pinned identity layer for HTTP/SSE requests:

```json
{
  "disable_codex_cloaking": true
}
```

The camel-case alias `disableCodexCloaking` and the local aliases `codex_preserve_identity_headers` / `codexPreserveIdentityHeaders` are also accepted.

With cloaking disabled, identity precedence is:

1. credential metadata headers;
2. provider headers;
3. caller headers allowed by the gateway header sanitizer.

The caller `User-Agent` is preserved when neither the provider nor credential supplies one. `Originator` is transmitted only when configured by the provider or credential. Authentication and account identity remain gateway-controlled. This policy applies to HTTP/SSE only and does not enable Codex WebSocket behavior.
