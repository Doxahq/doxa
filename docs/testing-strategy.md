# Doxa Platform Testing Strategy

## Default Rule

Default tests must be deterministic and local. They should not call GitHub, OpenRouter, Cloudflare, R2, Workers, Queues, or a live Postgres instance unless the test is explicitly marked as an opt-in integration smoke test.

## Test Matrix

| Area | Risk | Default Coverage | Deferred Coverage |
| --- | --- | --- | --- |
| `packages/generation` | Failed jobs publishing partial docs, leaked secrets, bad artifacts | Unit tests with fake internal API, fake container fetch, and in-memory artifact store | Live container plus real fixture repo |
| `packages/docs-engine` | Broken artifact layout or runtime manifest contract | Unit tests for href normalization, source paths, generated settings, search, and manifest schema | Property tests for broad path fuzzing |
| `apps/docs-runtime` | Runtime-source content leaks between projects, auth is bypassed, or legacy preview rendering regresses | Worker fetch tests with fake service binding and R2 plus renderer tests | Browser visual regression |
| `apps/api` | Auth/dev bypass mistakes, bad webhooks, bad GitHub mappings | Unit tests for helper modules, CORS, JSON parsing, webhook HMAC, GitHub App repository mapping | Route tests with injected repositories and local Postgres |
| `apps/agent-worker` | Queue ack/retry behavior breaks generation reliability | Unit tests with mocked generation coordinator and fake service binding | Queue integration through Wrangler |
| `packages/agent` | Agent runtime regressions | Existing Vitest suite | Opt-in live provider generation |

## Current Commands

```bash
pnpm test
pnpm typecheck
pnpm --filter @doxahq/generation test
pnpm --filter @doxahq/docs-engine test
pnpm --filter @doxahq/docs-runtime test
pnpm --filter @doxahq/api test
pnpm --filter @doxahq/agent-worker test
```

## Live Smoke Tests

Live generation should stay outside default CI until we have a stable fixture and cost guardrails. Run it manually with the local dashboard and `GENERATION_MODE=container-inline` when validating the real GitHub repo -> agent container -> R2 -> docs runtime content path.
