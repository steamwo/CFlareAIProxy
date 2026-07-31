# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CFlareAIProxy (package name `cflare-api`, deployed Worker name `cfap`) is a multi-account LLM API gateway running entirely on Cloudflare Workers. A single Worker (Hono) serves an OpenAI-compatible API (`/v1/models`, `/v1/responses`, `/v1/chat/completions`, `/v1/completions`) and a same-origin Vue 3 admin console at `/admin`, backed by D1, KV, Queues, and two Durable Objects.

It normalizes divergent upstream auth/protocols (Codex, Kimi, Qoder, OpenCode Zen, and arbitrary OpenAI-compatible providers) behind one API. Clients only ever hold a gateway key; upstream OAuth tokens, API keys, and proxy URLs are encrypted server-side.

## Commands

```bash
pnpm install
pnpm run doctor          # environment/config sanity check
pnpm run dev              # generates/completes .dev.vars, applies local D1 migrations, builds admin UI, starts Wrangler
```

Validation (run before considering a change done):

```bash
pnpm run check            # = config:check + check-web + typecheck (worker+web) + vitest run — the standard gate
```

Individual pieces of `check`:

```bash
pnpm run config:check     # wrangler deploy --dry-run --outdir .wrangler/dry-run
node scripts/check-web.mjs
pnpm run typecheck:worker # tsc -p tsconfig.worker.json --noEmit
pnpm run typecheck:web    # vue-tsc -p web/tsconfig.json --noEmit
pnpm run test             # vitest run
```

Single test file / pattern:

```bash
pnpm exec vitest run src/quota.test.ts
pnpm exec vitest run -t "some test name"
```

Build / deploy (deploy is not just `wrangler deploy` — see below):

```bash
pnpm run build             # typecheck + build:web (vite build → dist/)
pnpm run deploy             # build + node scripts/deploy.mjs
```

`node scripts/deploy.mjs` ensures the remote Queue exists, initializes missing critical Secrets, applies D1 migrations, and verifies schema before/around the Wrangler upload. Never substitute a bare `wrangler versions upload` for it in production deploys.

D1 migrations:

```bash
pnpm run db:migrate:local
pnpm run db:migrate:remote
```

Other scripts worth knowing: `pnpm run smoke` / `pnpm run smoke:admin` (end-to-end smoke checks), `pnpm run codex:login|import|refresh|sync|watch` (local Codex OAuth helpers).

## Architecture

**Entry points**: `src/worker.ts` is the actual Wrangler `main` — it wraps `src/index.ts`'s Hono app and adds the `scheduled` (cron) handler that purges expired request logs. `src/index.ts` defines the Hono app, `/v1/*` routes, `/health`, mounts the admin app (`src/admin.ts`), and exports the `queue()` consumer plus the two Durable Object classes (`AccountPool`, `RateLimiter`) that `wrangler.jsonc` binds. Durable Object class names/bindings and D1/Queue identifiers are treated as fixed contracts — see AGENTS.md invariants below.

**Request flow for `/v1/{responses,chat/completions,completions}`** (`src/proxy-v2.ts` → `proxyGeneration`):
1. Authenticate the gateway key, enforce its model scope / RPM / concurrency / monthly token budget (`RateLimiter` DO).
2. Resolve the public model to one or more routes ordered by priority (lower first) then split by weight within a priority tier (`src/models.ts`, `model_routes` table).
3. For the chosen route, lease a credential from `AccountPool` (DO) — this handles account cooldown, quota exhaustion, session affinity (`X-Session-Id` / `X-Conversation-Id`), concurrency limits, and OAuth refresh locking.
4. Dispatch to the provider adapter under `src/providers/` (`codex.ts`, `kimi.ts`, `qoder.ts`, `opencode.ts` + `opencode-anonymous.ts` + `opencode-failover.ts`, `generic.ts` for OpenAI-compatible upstreams). Adapters translate between the gateway's OpenAI-compatible shape and the upstream's native protocol (e.g. Codex is Responses-first with Chat/Completions conversion; OpenCode Zen adapter internally speaks Anthropic Messages / Google GenerateContent to its upstreams but that is not exposed externally).
5. On retryable failures, fail over to the next account, then the next route; sustained network/5xx failures trip a provider circuit breaker (`src/routing-health.ts`).
6. Stream the response back (`src/stream.ts`), release the DO lease, and push usage/latency/cost asynchronously onto `USAGE_QUEUE` (consumed by `persistUsageQueueBatch` in `src/usage-storage.ts`) rather than on the response's critical path.

**Built-in channels vs. custom providers**: `src/builtin-channels.ts` is a fixed code registry for Codex/Kimi/Qoder/OpenCode Zen (endpoints, OAuth config, protocol rules — not DB-editable). Arbitrary OpenAI-compatible upstreams are configured as regular `providers` rows with discoverable models, aliases, and weights. Do not conflate the credential-management responsibilities of these two paths (built-in account pool page vs. provider configuration page in the admin UI) — this separation is called out explicitly in AGENTS.md.

**Model capability metadata**: `src/model-capabilities.ts` attaches a non-standard `x_cflare_capabilities` field to `/v1/models` entries (input/output modalities, reasoning levels, tool/image support). The gateway rejects requests that need capabilities the resolved model doesn't declare, before spending an upstream call.

**Proxy resolution order**: account-level `proxy_url` → provider/built-in-channel proxy URL → system default proxy URL → direct. Account-level `direct`/`none` explicitly opts out of inheriting provider/system proxy. Proxying is native Worker HTTP CONNECT / SOCKS5 (see `src/upstream-fetch.ts`); a selected proxy that fails returns an error rather than silently falling back to direct. Details: `docs/PROVIDER_PROXY.md`.

**Persistence**:
- **D1** (`migrations/*.sql`, applied in order, append-only — never edit a shipped migration): providers, encrypted credentials, discovered models, quota snapshots, routes, gateway keys, prices, request logs/activity aggregates.
- **Durable Objects**: `AccountPool` (account leasing, concurrency, session affinity, refresh locks) and `RateLimiter` (gateway key RPM/concurrency/token limits) — both SQLite-backed DOs per `wrangler.jsonc` migrations.
- **KV** (`CONFIG_CACHE`): short-lived provider/model config cache.
- **Queues** (`USAGE_QUEUE` / `cflare-api-usage`, DLQ `cflare-api-usage-dlq`): async usage/cost writes.
- Credentials/API keys/proxy URLs are AES-GCM encrypted with `MASTER_KEY` (`src/crypto.ts`); gateway keys are stored hashed only, shown once at creation.

**Admin surface**: `src/admin.ts` builds the `/admin/api/*` Hono sub-app (auth via `ADMIN_USERNAME`/`ADMIN_PASSWORD` + `ADMIN_TOKEN`-signed HttpOnly cookie sessions); a few overview/settings/credential-export routes are mounted directly in `src/index.ts` instead. The Vue 3 SPA lives under `web/` (Pinia stores in `web/src/stores/`, views in `web/src/views/`, API client in `web/src/api.ts`) and is built by `vite build` into `dist/`, served by the same Worker via `assets` in `wrangler.jsonc` (with `run_worker_first` carving out `/`, `/health`, `/v1/*`, `/admin/api/*`, `/oauth/*` so the Worker — not static assets — handles those paths).

**Two TypeScript projects**: `tsconfig.worker.json` (Worker runtime, `src/**` + `test/**`, strict + `noUncheckedIndexedAccess`) and `web/tsconfig.json` (Vue admin app), checked independently via `typecheck:worker` / `typecheck:web`. Worker tests (`src/*.test.ts`, `test/*.test.ts`) run under vitest with `node` environment; `cloudflare:sockets` is aliased to `test/mocks/cloudflare-sockets.ts` since real sockets aren't available outside Workers.

## Repository invariants (see AGENTS.md for the full policy)

- Production Worker name is fixed as `cfap` and must match the Cloudflare Dashboard/Git integration target; the `cflare-api*` package/D1/Queue identifiers are separate resources — don't rename them together.
- Durable Object class names/bindings (`AccountPool`, `RateLimiter`) and their migration records must not change casually.
- `/v1/*`, `/admin/api/*`, `/oauth/*`, the Queue consumer, the Cron handler, and static asset routing must all keep working.
- Migrations are append-only; never alter the semantics of a shipped migration file.
- Account-pool and overview stats must use bounded queries — no full-table aggregation that scales with unbounded log history.
- Upstream protocol conversion, error classification, streaming, and usage recording changes must preserve the existing public API.
- Don't bypass `scripts/deploy.mjs`'s resource/secret initialization for production deploys.
- Feature branches: `agent/<description>` off latest `dev`; flow is feature branch → `dev` → verify deploy → `main`. Don't force-push or rewrite shared branch history.
