# Doxabot Production Promotion and Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely update production documentation from default-branch pushes, promote an identical preview without redundant model work, and make Doxabot recoverable and observable in production.

**Architecture:** The default-branch push event is the only automation publication authority. The orchestrator either promotes a successful preview whose exact source tree and generator fingerprint match or launches an incremental publication from the currently published version. Compare-and-set publication prevents stale output. Supersession, reconciliation, retention, metrics, and a dead-letter queue close the at-least-once operational loop.

**Tech Stack:** TypeScript, Cloudflare Workers, Queues, Workflows, Containers, R2, PostgreSQL, GitHub Checks API, Vitest.

## Global Constraints

- Complete and commit incremental preview generation first.
- A merged pull-request webhook is not authority to publish. Wait for the corresponding default-branch push.
- Promotion requires exact source tree hash equality and generator fingerprint compatibility; commit-message or head-SHA similarity is insufficient.
- Every production pointer update uses compare-and-set against the baseline version recorded by the job.
- A superseded or cancelled job may not upload, complete, promote, or publish late output.
- Public-repository automation remains disabled throughout rollout.
- Production flag, queue/DLQ binding, cron trigger, and concurrency changes require explicit approval before configuration edits.

---

## Task 1: Plan production work from default-branch pushes

**Files:**

- Create: `apps/api/src/services/doxabot/production-planner.ts`
- Create: `apps/api/tests/services/doxabot-production-planner.test.ts`
- Modify: `apps/api/src/services/doxabot/webhook-orchestrator.ts`
- Modify: `apps/api/src/repositories/docs.ts`
- Modify: `apps/api/src/repositories/preview-channels.ts`
- Modify: `apps/api/src/repositories/jobs.ts`

- [ ] Define `ProductionUpdatePlan` as `promote_preview | generate_incrementally | no_change` with all identity fields required for execution.
- [ ] On a normalized default-branch push, load the current published version, the new source revision/tree, compatible successful preview candidates, and generator fingerprint.
- [ ] Select `promote_preview` only for exact tree hash and generator fingerprint equality.
- [ ] Select `no_change` only when the published tree and fingerprint already equal the new state.
- [ ] Otherwise create an idempotent `publicationMode=publish` job with concurrency key `publish:<projectId>` and the current published version as baseline.
- [ ] Ignore pushes for disabled Doxabot settings while preserving the recorded webhook-delivery outcome.
- [ ] Test exact preview match, mismatched tree, mismatched fingerprint, no preview, already published tree, disabled setting, duplicate push, and competing push deliveries.
- [ ] Run `pnpm --filter @doxahq/api test -- doxabot-production-planner` and `pnpm --filter @doxahq/api typecheck`.
- [ ] Commit: `feat(doxabot): plan default-branch documentation updates`

## Task 2: Promote an identical preview atomically

**Files:**

- Modify: `apps/api/src/repositories/docs.ts`
- Modify: `apps/api/src/services/internal-api.ts`
- Modify: `apps/api/src/routes/internal.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/tests/services/preview-promotion.test.ts`

- [ ] Add a provider-neutral internal `promotePreview` command with project, preview version, expected published baseline, target revision/tree, and generator fingerprint.
- [ ] In one database transaction, validate that the candidate preview is complete and belongs to the project, compare its tree/fingerprint, compare-and-set the published pointer, and mark the version published.
- [ ] Return a typed stale-baseline result instead of overwriting a newer published version.
- [ ] Keep the preview channel pointing to the promoted version until normal retention closes it.
- [ ] Do not copy R2 artifacts or invoke a model during promotion.
- [ ] Test success, duplicate promotion, wrong project, incomplete preview, tree mismatch, fingerprint mismatch, and concurrent publication winning first.
- [ ] Run `pnpm --filter @doxahq/api test -- preview-promotion` and `pnpm --filter @doxahq/api typecheck`.
- [ ] Commit: `feat(doxabot): promote matching previews without regeneration`

## Task 3: Publish incremental production generations with stale-output protection

**Files:**

- Modify: `apps/agent-worker/src/generation-workflow-entrypoint.ts`
- Modify: `apps/api/src/services/internal-api.ts`
- Modify: `apps/api/src/repositories/docs.ts`
- Modify: `apps/api/src/repositories/jobs.ts`
- Create: `apps/agent-worker/tests/production-generation-workflow.test.ts`
- Create: `apps/api/tests/services/production-publication.test.ts`

- [ ] Reuse the same revision-aware incremental stages used by previews with `publicationMode=publish` and the recorded published baseline.
- [ ] Before each expensive stage and before final completion, check job cancellation/supersession and target default-branch revision.
- [ ] Make final completion compare-and-set both active job identity and published baseline version.
- [ ] Reject a late result after cancellation, supersession, a newer push, or another successful publication.
- [ ] Update the associated review run when one exists, while keeping default-branch automation correct without a pull-request context.
- [ ] Test normal publication, no-impact publication, newer push during generation, manual publication winning, cancellation during a page batch, and late completion rejection.
- [ ] Run `pnpm --filter @doxahq/agent-worker test -- production-generation-workflow`, `pnpm --filter @doxahq/api test -- production-publication`, and relevant typechecks.
- [ ] Commit: `feat(doxabot): publish guarded default-branch updates`

## Task 4: Supersede obsolete pull-request heads end to end

**Files:**

- Create: `apps/api/src/services/doxabot/supersession.ts`
- Create: `apps/api/tests/services/doxabot-supersession.test.ts`
- Modify: `apps/api/src/services/doxabot/webhook-orchestrator.ts`
- Modify: `apps/api/src/repositories/jobs.ts`
- Modify: `apps/agent-worker/src/index.ts`
- Modify: `apps/agent-worker/src/generation-workflow-entrypoint.ts`

- [ ] When a proposal receives a new head, atomically mark the prior active job superseded before admitting the replacement.
- [ ] Propagate cancellation to the workflow, active container request, model request, and pending artifact delivery using the existing job-scoped cancellation mechanism.
- [ ] Write a cancellation tombstone checked by all late delivery/publication paths.
- [ ] Complete the old GitHub Check Run as cancelled and create a distinct run for the new head.
- [ ] Make repeated synchronize deliveries idempotent and safe when the old workflow is already complete.
- [ ] Test supersession before start, during analysis, during page generation, after artifact upload, and immediately before completion.
- [ ] Run `pnpm --filter @doxahq/api test -- doxabot-supersession`, `pnpm --filter @doxahq/agent-worker test`, and relevant typechecks.
- [ ] Commit: `feat(doxabot): supersede obsolete preview runs`

## Task 5: Rebase open previews after production changes

**Files:**

- Create: `apps/api/src/services/doxabot/preview-rebaser.ts`
- Create: `apps/api/tests/services/doxabot-preview-rebaser.test.ts`
- Modify: `apps/api/src/repositories/change-proposals.ts`
- Modify: `apps/api/src/repositories/preview-channels.ts`
- Modify: `apps/api/src/services/internal-api.ts`

- [ ] After a successful production promotion/publication, list enabled open proposals whose preview baseline is older than the new published version.
- [ ] Re-fetch each proposal's current base/head metadata through the GitHub adapter before queueing.
- [ ] Requeue only heads still targeting the current default branch and still open/ready; close or ignore the rest.
- [ ] Create a new idempotency key that includes the new baseline version so unchanged PR heads can be recomputed against changed production.
- [ ] Mark the prior preview stale while keeping its URL available until the replacement succeeds.
- [ ] Rate-limit fan-out and continue processing other proposals when one GitHub lookup fails.
- [ ] Test zero proposals, multiple proposals, closed/draft/retargeted proposals, unchanged baseline replay, partial API failure, and concurrent new-head delivery.
- [ ] Run `pnpm --filter @doxahq/api test -- doxabot-preview-rebaser` and `pnpm --filter @doxahq/api typecheck`.
- [ ] Commit: `feat(doxabot): refresh previews after production updates`

## Task 6: Close and retain preview channels safely

**Files:**

- Create: `apps/api/src/services/doxabot/preview-retention.ts`
- Create: `apps/api/tests/services/doxabot-preview-retention.test.ts`
- Modify: `apps/api/src/services/doxabot/webhook-orchestrator.ts`
- Modify: `apps/api/src/repositories/preview-channels.ts`
- Modify: `apps/docs-runtime/src/runtime-source.ts`

- [ ] On a closed proposal, mark its preview channel closed and set expiry to 14 days; do not delete artifacts synchronously in the webhook request.
- [ ] Keep closed preview URLs resolvable until expiry with a visible closed-preview state available to the runtime shell.
- [ ] Add an idempotent retention sweep that removes expired channel pointers and then deletes only unreferenced preview artifacts/state.
- [ ] Never delete a version currently referenced by production, another preview channel, or a pending job baseline.
- [ ] Test closed-unmerged, merged, reopened-before-expiry, repeated close, promoted preview, shared reference, expiry boundary, and interrupted cleanup.
- [ ] Run `pnpm --filter @doxahq/api test -- doxabot-preview-retention`, `pnpm --filter @doxahq/docs-runtime test`, and relevant typechecks.
- [ ] Commit: `feat(doxabot): retain and expire preview channels`

## Task 7: Add reconciliation and dead-letter recovery

**Files:**

- Create: `apps/api/src/services/doxabot/reconciler.ts`
- Create: `apps/api/tests/services/doxabot-reconciler.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/wrangler.json`
- Modify: `apps/agent-worker/wrangler.json`
- Modify: `apps/api/.dev.vars.example`

- [ ] Stop for explicit approval before changing Wrangler queue, DLQ, or cron configuration.
- [ ] Add a dead-letter queue with bounded retries for failed automation admission and document replay ownership.
- [ ] Add a scheduled reconciler that scans bounded pages of stuck delivery claims, jobs without workflows, review-run updates pending retry, stale active jobs, and expired preview channels.
- [ ] Claim reconciliation work with compare-and-set leases so overlapping cron invocations cannot duplicate recovery.
- [ ] Re-enqueue only from durable normalized state and original idempotency keys; never reconstruct work from an unvalidated raw payload.
- [ ] Record terminal poison events with safe error codes and keep secrets/source contents out of logs.
- [ ] Test queue-send recovery, missing workflow recovery, duplicate cron runs, lease expiry, poison event, Check API outage, and bounded pagination.
- [ ] Run `pnpm --filter @doxahq/api test -- doxabot-reconciler`, relevant worker tests, and typechecks.
- [ ] Commit: `feat(doxabot): reconcile failed automation delivery`

## Task 8: Add metrics, runbooks, and rollout gates

**Files:**

- Create: `apps/api/src/services/doxabot/metrics.ts`
- Create: `apps/api/tests/services/doxabot-metrics.test.ts`
- Create: `docs/doxabot-github-operations.md`
- Modify: `docs/generation-observability.md`
- Modify: `apps/api/.dev.vars.example`

- [ ] Emit structured events for webhook claimed/ignored, queue latency, workflow duration, model-call count, tokens, regenerated/reused pages, preview completion, promotion hit rate, supersession, failure class, and reconciliation.
- [ ] Key operational correlation by delivery ID, job ID, project ID, provider, proposal external ID, and source revision; exclude repository source, prompts, tokens, and installation credentials.
- [ ] Document alert thresholds for delivery backlog, failure rate, workflow age, Check update failure, and publication staleness.
- [ ] Document manual replay, cancellation, public-policy confirmation, DLQ inspection, preview cleanup, and global kill-switch procedures.
- [ ] Add a release checklist that verifies `DOXABOT_PUBLIC_REPOSITORIES_ENABLED=false` and requires separate approval to change `DOXABOT_ENABLED` in production.
- [ ] Test metric classification and redaction with sentinel secrets/source strings.
- [ ] Run `pnpm --filter @doxahq/api test -- doxabot-metrics`, `pnpm --filter @doxahq/api typecheck`, and inspect the runbook links/commands.
- [ ] Commit: `docs(doxabot): add operations and rollout runbook`

## Task 9: Prove the end-to-end private-repository workflow

**Files:**

- Create: `tests/doxabot/private-repository-flow.test.ts`
- Create: `tests/doxabot/fixtures/private-repository/`
- Create: `tests/doxabot/fixtures/public-repository/`
- Modify: `package.json`

- [ ] Build deterministic Git repositories and signed webhook fixtures for initial publication, pull-request open, synchronize, draft/ready, merge/default push, close, public repository, duplicate delivery, and merge conflict.
- [ ] Stub GitHub installation tokens and Checks API at the HTTP boundary while using real repositories, schemas, planners, and workflow state machines.
- [ ] Assert one private PR produces one isolated preview, no production pointer update, and a successful Check Run with its URL.
- [ ] Assert the matching default push promotes without model calls and a nonmatching push runs incremental production generation.
- [ ] Assert the public fixture records `public_repository_disabled` and produces no job, workflow, Check Run, preview, or production update.
- [ ] Assert duplicate/reordered deliveries and superseded workflows cannot publish duplicate or stale output.
- [ ] Add a root `test:doxabot` script and document that any live GitHub App smoke test is opt-in and requires a disposable private repository.
- [ ] Run `pnpm test:doxabot`, `pnpm test`, `pnpm typecheck`, and `pnpm build`.
- [ ] Commit: `test(doxabot): cover private repository automation flow`

---

## Final Release Verification

- [ ] Run `pnpm test:doxabot` twice to prove replay safety.
- [ ] Run `pnpm test`, `pnpm typecheck`, and `pnpm build`.
- [ ] Run `git diff --check` and inspect every migration and Wrangler change.
- [ ] Confirm no public-repository UI override exists and the public fixture launches no work.
- [ ] Confirm the global production flag remains false until the separately approved release operation.
- [ ] In an approved disposable private repository, verify Check permissions, preview URL, synchronize supersession, default-branch promotion, and preview retention.
