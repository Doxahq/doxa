# Doxabot GitHub Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project owner enable Doxabot for an eligible private GitHub repository and reliably translate relevant GitHub events into idempotent automation jobs with Check Run status.

**Architecture:** The API stores provider-neutral automation settings, deliveries, change proposals, preview channels, and job provenance. A thin GitHub adapter validates narrow webhook payloads and normalizes them into internal events. An orchestration service applies eligibility and default-branch rules before enqueueing. Provider-neutral review-run commands call a GitHub Checks adapter without coupling generation workflows to GitHub.

**Tech Stack:** TypeScript, Zod, Hono, Drizzle ORM, PostgreSQL, Cloudflare Queues, GitHub Apps API, TanStack Router/Query, React, Vitest.

## Global Constraints

- Complete and commit the security and policy foundation first.
- Do not enable public repositories. A public delivery is deduplicated and recorded with `public_repository_disabled`, then stops.
- Store narrow normalized metadata, not entire webhook payloads.
- Use the stable GitHub repository ID and installation ID for lookup. Do not identify a repository only by owner/name.
- The HTTP route authenticates and acknowledges; business rules live in services and persistence lives in repositories.
- Queue publication occurs only after the delivery row and normalized event state are durably committed.
- No pull-request comment API is in scope.

---

## Task 1: Add Doxabot persistence and automation job provenance

**Files:**

- Modify: `packages/db/src/schema/doxa.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/migrations/0009_doxabot_foundation.sql`
- Create: `packages/db/migrations/meta/0009_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`
- Create: `apps/api/tests/repositories/doxabot-schema.test.ts`

- [ ] Add `doxabot_automation_settings` keyed by project ID with `enabled`, timestamps, and the actor that last changed it.
- [ ] Add `scm_webhook_deliveries` with provider plus delivery ID uniqueness, event/action, repository external ID, payload hash, processing status, ignore reason, error code, and timestamps.
- [ ] Add `scm_change_proposals` with project/provider/external ID uniqueness, display number, draft/state, default/base refs, base/head revisions, last source-tree hash, and timestamps.
- [ ] Add `docs_preview_channels` with project/site/provider/change uniqueness, hostname uniqueness, current version, lifecycle state, and expiry time.
- [ ] Extend generation jobs with `trigger`, `publicationMode`, nullable requester, provider/change references, baseline/target revisions, source-tree hash, baseline version, generator fingerprint, idempotency key, concurrency key, external review-run ID, and superseding job reference.
- [ ] Replace the project-wide active-job uniqueness rule with an active `concurrencyKey` uniqueness rule. Manual publication uses `publish:<projectId>`; pull-request previews use `preview:<projectId>:<provider>:<changeExternalId>`.
- [ ] Extend documentation versions with `channel`, source revision/tree hash, baseline version, generator fingerprint, and permanent generation-state prefix.
- [ ] Generate the migration through the existing Drizzle script, inspect the SQL, and ensure all new non-null columns have safe backfill behavior for existing rows.
- [ ] Test unique delivery, unique preview channel, independent preview concurrency keys, and the retained single production key.
- [ ] Assert table columns and indexes with Drizzle's table metadata helpers, then run `pnpm --filter @doxahq/api test -- doxabot-schema`, `pnpm --filter @doxahq/db typecheck`, and `pnpm --filter @doxahq/db db:check` against the approved test database.
- [ ] Commit: `feat(db): add doxabot control-plane state`

## Task 2: Add focused repositories and settings service

**Files:**

- Create: `apps/api/src/repositories/doxabot-settings.ts`
- Create: `apps/api/src/repositories/webhook-deliveries.ts`
- Create: `apps/api/src/repositories/change-proposals.ts`
- Create: `apps/api/src/repositories/preview-channels.ts`
- Modify: `apps/api/src/repositories/jobs.ts`
- Create: `apps/api/src/services/doxabot/settings.ts`
- Create: `apps/api/tests/services/doxabot-settings.test.ts`

- [ ] Define repository interfaces before implementations. Keep each repository responsible for one aggregate.
- [ ] Add an atomic `claimDelivery` operation returning `claimed | duplicate`; never emulate the uniqueness check with read-then-write.
- [ ] Add compare-and-set methods for change-proposal head revisions and preview-channel version pointers.
- [ ] Add generation-job creation that accepts an idempotency key and returns the existing job on replay.
- [ ] Implement settings reads through `evaluateDoxabotEligibility` so the dashboard receives both stored state and current availability.
- [ ] Implement settings updates that authorize the project owner and reject enablement when unavailable. Disabling remains allowed even if policy later becomes unavailable.
- [ ] Test ownership, initial-generation requirement, private enablement, public rejection, global shutdown, disable behavior, delivery races, and replayed job creation.
- [ ] Run `pnpm --filter @doxahq/api test -- doxabot-settings` and `pnpm --filter @doxahq/api typecheck`.
- [ ] Commit: `feat(api): add doxabot settings domain`

## Task 3: Expose project Doxabot settings in the API

**Files:**

- Create: `apps/api/src/routes/doxabot.ts`
- Modify: `apps/api/src/routes/projects.ts`
- Modify: `packages/contracts/src/doxabot.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/tests/http/projects.test.ts`

- [ ] Add response and update-input schemas for `DoxabotSettingsDto`, including stored enablement, repository visibility, availability, unavailable reason, and update timestamp.
- [ ] Add `GET /projects/:projectId/doxabot` and `PUT /projects/:projectId/doxabot` as thin authenticated handlers.
- [ ] Reuse existing project ownership middleware and map domain errors to stable 403, 404, and 409 responses.
- [ ] Return 409 with `public_repository_disabled` if a caller attempts to enable a public repository.
- [ ] Test unauthenticated access, wrong owner, eligible private project, public project, missing published version, enabling, disabling, and idempotent repeated updates.
- [ ] Run `pnpm --filter @doxahq/api test -- projects` and `pnpm --filter @doxahq/api typecheck`.
- [ ] Commit: `feat(api): expose doxabot project settings`

## Task 4: Add the dashboard Doxabot settings surface

**Files:**

- Create: `apps/web/src/lib/dashboard/doxabot-model.ts`
- Create: `apps/web/tests/doxabot-model.test.ts`
- Create: `apps/web/src/lib/dashboard/use-project-doxabot.ts`
- Create: `apps/web/src/components/dashboard/project-doxabot-page.tsx`
- Create: `apps/web/src/routes/dashboard/projects/$projectId/doxabot.tsx`
- Modify: `apps/web/src/lib/platform-api.ts`
- Modify: `apps/web/src/lib/queries/dashboard.ts`
- Modify: `apps/web/src/components/dashboard/project-workspace-layout.tsx`

- [ ] Add typed platform API methods and query keys for reading and updating Doxabot settings.
- [ ] Add a pure view-model function covering loading, enabled, disabled, globally unavailable, initial-generation-required, public-disabled, and disconnected states.
- [ ] Test the view model without rendering or network mocks.
- [ ] Add a `Doxabot` workspace tab and a thin route that renders the page component.
- [ ] Use existing Button, Badge, Alert, and Card components. Show `Private repositories only` and render the enable control disabled for public repositories.
- [ ] On mutation success, invalidate only the Doxabot setting query. Surface API errors through the existing toast convention.
- [ ] Do not expose or accept a public-repository override in the client.
- [ ] Run `pnpm --filter @doxahq/web test -- doxabot-model`, `pnpm --filter @doxahq/web typecheck`, and `pnpm --filter @doxahq/web build`.
- [ ] Commit: `feat(web): add doxabot project settings`

## Task 5: Parse and normalize narrow GitHub events

**Files:**

- Create: `apps/api/src/services/doxabot/github-event-parser.ts`
- Create: `apps/api/tests/services/github-event-parser.test.ts`
- Modify: `packages/contracts/src/source-control.ts`

- [ ] Define minimal Zod schemas for the fields used from `pull_request`, `push`, `repository`, and installation lifecycle payloads.
- [ ] Normalize pull-request actions `opened`, `reopened`, `synchronize`, `ready_for_review`, `converted_to_draft`, and `closed` into provider-neutral change events.
- [ ] Normalize push events only when the pushed ref equals the payload repository's default branch ref.
- [ ] Preserve repository ID, visibility, installation ID, default branch, PR external ID/number, draft/merged state, base ref/SHA, and head SHA.
- [ ] Return a typed `irrelevant` result for unhandled events/actions instead of throwing.
- [ ] Test malformed inputs, renamed repositories with stable IDs, fork-origin pull requests, non-default bases, default pushes, non-default pushes, public visibility, drafts, and merged closes.
- [ ] Run `pnpm --filter @doxahq/api test -- github-event-parser` and `pnpm --filter @doxahq/api typecheck`.
- [ ] Commit: `feat(doxabot): normalize github webhook events`

## Task 6: Orchestrate delivery deduplication, filtering, and enqueueing

**Files:**

- Create: `apps/api/src/services/doxabot/webhook-orchestrator.ts`
- Create: `apps/api/tests/services/doxabot-webhook-orchestrator.test.ts`
- Modify: `apps/api/src/routes/github.ts`
- Create: `apps/api/tests/http/github-webhook-route.test.ts`
- Modify: `apps/api/src/env.ts`

- [ ] Make the route require `X-GitHub-Delivery`, `X-GitHub-Event`, and a valid signature over the raw body before JSON parsing.
- [ ] Hash the raw payload, claim the delivery, and return success immediately for an already-claimed delivery without enqueueing again.
- [ ] Resolve the project from the stable repository ID, evaluate Doxabot policy, and persist the resulting processed or ignored outcome.
- [ ] Record public repositories as ignored with `public_repository_disabled`. Do not create a change proposal, generation job, workflow, or Check Run.
- [ ] For pull requests, require the current default branch as base, upsert the proposal, and enqueue only non-draft eligible heads. Record draft and non-default-base events as ignored until a relevant later action arrives.
- [ ] For a new head, create the idempotency key from project, provider, proposal external ID, head SHA, and generator fingerprint.
- [ ] Publish to the queue only after database state commits; if queue publication fails, leave a recoverable delivery status for the reconciler.
- [ ] Return 202 for authenticated claimed deliveries and a non-retrying 2xx result for irrelevant authenticated deliveries.
- [ ] Test duplicate deliveries, reordered actions, repeated head SHA, public events, disabled projects, wrong base, draft-to-ready, queue failure, and concurrent claims.
- [ ] Run `pnpm --filter @doxahq/api test -- doxabot-webhook-orchestrator webhooks` and `pnpm --filter @doxahq/api typecheck`.
- [ ] Commit: `feat(doxabot): ingest github automation events`

## Task 7: Add provider-neutral review runs backed by GitHub Checks

**Files:**

- Create: `packages/contracts/src/review-runs.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/services/doxabot/review-runs.ts`
- Create: `apps/api/src/services/doxabot/github-checks.ts`
- Create: `apps/api/tests/services/github-checks.test.ts`
- Modify: `apps/api/src/services/internal-api.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] Define provider-neutral commands to create and update a review run with status, optional conclusion, title, summary, details URL, source revision, and external run ID.
- [ ] Implement the GitHub adapter with installation-token authentication and exact repository scoping.
- [ ] Update the GitHub App manifest/installation guidance to require only `Metadata: read`, `Contents: read`, `Pull requests: read`, and `Checks: write`, plus `pull_request` and `push` events. Stop for approval before changing the installed app's permissions.
- [ ] Create one Check Run per accepted head SHA named `Doxa documentation preview`.
- [ ] Map Doxabot states to GitHub states: queued, in progress, success, failure, cancelled, and action required.
- [ ] Keep summaries concise and include preview URL, changed source count, regenerated page count, and reused page count when available.
- [ ] Add authenticated internal RPC endpoints so the workflow calls provider-neutral commands rather than GitHub directly.
- [ ] Test request bodies, installation scoping, token/API failures, external ID persistence, replayed updates, and every state mapping.
- [ ] Run `pnpm --filter @doxahq/contracts typecheck`, `pnpm --filter @doxahq/api test -- github-checks`, and `pnpm --filter @doxahq/api typecheck`.
- [ ] Commit: `feat(doxabot): report previews with github checks`

---

## Phase Verification

- [ ] Run `pnpm test`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm build`.
- [ ] Run `git diff --check`.
- [ ] Replay the same signed private-repository fixture twice and verify one delivery claim, one job, and one Check Run.
- [ ] Replay an equivalent public-repository fixture and verify an ignored delivery with no downstream records.
