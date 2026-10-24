# Docs Cache Invalidation Implementation Plan

> Execute inline without sub-agents. Preserve the existing staged cache changes. Do not commit, apply migrations, or deploy.

**Goal:** Attempt targeted hostname-cache invalidation after every production publish and recover failed attempts from a durable outbox.

**Architecture:** Write an immutable outbox task in the same transaction as the production pointer or domain change. After commit, claim and deliver that task through a private service binding to `DocsHostCache.invalidate`. Retry pending tasks through the existing five-minute API scheduler. Keep the five-second hostname TTL and version-keyed HTML cache.

**Tech Stack:** TypeScript, Drizzle/PostgreSQL, Cloudflare Workers Cache, private Worker RPC, Vitest.

**Spec:** The approved design in this conversation and `docs/current/production-docs-caching.md`. Purge acceptance is not a strict global read-after-write guarantee.

## Constraints

- No public purge route or new token.
- Purge only the hostname cache. A new production version selects a different HTML cache key.
- Check the Cloudflare purge result, including `success: false`.
- No network calls inside publish transactions.
- Failed purges must not turn a committed publish into an apparent failed publish.
- Outbox tasks survive domain/site removal. Do not use cascading foreign keys.
- Expiring claims and claim tokens protect concurrent retry attempts.
- Preserve unknown/private/preview cache bypasses.

## Task 1: Targeted dispatcher invalidation

Files: contracts, dispatcher cache policy, dispatcher entrypoint, dispatcher tests.

- [x] Add failing tests for site/hostname tags and rejected purge results.
- [x] Add the RPC contract `invalidate(input: { siteId: string; hostname?: string }): Promise<void>`.
- [x] Tag only public production hostname responses. Use encoded tag values to prevent separator injection.
- [x] Implement `DocsHostCache.invalidate` with `ctx.cache.purge({ tags })`. Throw on absent cache context or unsuccessful result.
- [x] Run dispatcher tests and typecheck.

## Task 2: Durable outbox and retry worker

Files: DB schema/migration, API outbox repository, retry service, mutation helper, service/repository tests.

- [x] Add failing service tests for success, failure, retry delay, timeout, missing binding, and continued processing after one failure.
- [x] Create `docs_cache_invalidations`: UUID id, site UUID, optional hostname, attempts, next attempt, claim token/expiry, completed time, last error, created time.
- [x] Generate migration files only.
- [x] Claim due rows inside a short `FOR UPDATE SKIP LOCKED` transaction. Increment attempts and attach a fresh claim token.
- [x] Require that token for completion/failure updates. Expired claims are reclaimable.
- [x] Bound each purge attempt to three seconds. Retry with 30-second exponential delay capped at one hour, subject to the scheduler cadence.
- [x] Implement the mutation helper: enqueue within transaction, attempt only after successful commit, retain committed result after delivery failure.
- [x] Add transaction-order and rollback tests. Run API/DB checks.

## Task 3: Connect all mutation paths

Files: API docs, jobs, docs-content, docs-domains repositories; API environment, scheduler, Wrangler config.

- [x] Wrap `publishJob`, production `completeJob`, `promoteForProject`, and `createContentVersion` with the mutation helper.
- [x] Do not enqueue production invalidation for preview completion or rejected/no-op promotion.
- [x] Wrap domain create, eligibility changes, and delete. Preserve the deleted hostname in the outbox payload.
- [x] Add the production-only private binding to `doxa-docs-renderer#DocsHostCache`.
- [x] Add retry processing to the existing scheduler without changing generation queue processing or cron frequency.
- [x] Run regression tests for these repository paths and the full API suite.

## Task 4: Documentation and verification

- [x] Update the cache document with implemented paths, retry behavior, migration/deployment order, local behavior, and remaining freshness limits.
- [x] Run dispatcher/API/contracts/DB typechecks and tests, plus deployment dry-runs where local tooling permits.
- [x] Inspect the final diff and preserve index contents.
- [x] Report skipped database/live-cache checks explicitly. Deployment validation must exercise a real purge, a promotion, editor publish, and domain deletion.

## Test strategy

Use unit tests for retry decisions and tag isolation. Use real repository methods with controlled database boundaries for transaction integration. Test the emitted Drizzle claim/update queries without accessing a live database. Keep native Cloudflare hit/purge propagation checks separate from local tests. UI tests are unnecessary because this change has no UI surface.

## Completion report

Implemented all four tasks locally on 2026-09-16. No migration was applied and
no deployment or commit was performed. Existing staging was preserved; these
invalidation additions remain unstaged.

Verification:

- API: 501 tests passed; typecheck passed.
- Dispatcher: 77 tests passed; typecheck passed.
- Contracts: typecheck passed.
- Database: typecheck, 4 client tests, and 8 migration-file tests passed.
- Generated snapshot: only the outbox table was added; existing tables and enums
  are unchanged, and the snapshot chain is valid.
- API production and dispatcher Wrangler dry-runs passed. These checks bundle
  code and validate config; they do not deploy or confirm remote binding access.
- Production configuration validation and `git diff --check` passed.

Not run: migration execution, live PostgreSQL contention/crash recovery, and
Cloudflare cache-hit/purge propagation checks. The operations document lists the
first-rollout order and required live smoke tests.
