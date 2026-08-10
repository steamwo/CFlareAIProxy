const CLIENT_IDENTITY_TTL_MS = 5 * 60_000;
const MAX_STORED_REQUESTS = 2048;

interface StoredIdentity {
  official: boolean;
  expiresAt: number;
}

const identities = new Map<string, StoredIdentity>();

function cleanup(now: number): void {
  for (const [requestId, entry] of identities) {
    if (entry.expiresAt <= now) identities.delete(requestId);
  }
  while (identities.size >= MAX_STORED_REQUESTS) {
    const oldest = identities.keys().next().value as string | undefined;
    if (!oldest) break;
    identities.delete(oldest);
  }
}

function matchesOfficialCodexIdentity(value: string | null): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) return false;
  return normalized.startsWith("codex desktop/")
    || normalized === "codex desktop"
    || normalized.startsWith("codex-tui/")
    || normalized === "codex-tui"
    || normalized.startsWith("codex_cli_rs/")
    || normalized === "codex_cli_rs";
}

export function isOfficialCodexClient(request: Request): boolean {
  return matchesOfficialCodexIdentity(request.headers.get("user-agent"))
    || matchesOfficialCodexIdentity(request.headers.get("originator"));
}

export function rememberCodexClientIdentity(requestId: string, request: Request): void {
  const now = Date.now();
  cleanup(now);
  identities.set(requestId, {
    official: isOfficialCodexClient(request),
    expiresAt: now + CLIENT_IDENTITY_TTL_MS,
  });
}

export function isRememberedOfficialCodexClient(requestId: string): boolean {
  cleanup(Date.now());
  return identities.get(requestId)?.official === true;
}
