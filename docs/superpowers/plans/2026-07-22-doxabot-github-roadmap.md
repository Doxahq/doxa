# Doxabot for GitHub Delivery Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a private-repository-only Doxabot that creates documentation previews for pull requests targeting the repository default branch and updates production documentation only from the default branch.

**Architecture:** Doxabot is a provider-neutral automation pipeline with a GitHub adapter. GitHub webhooks are authenticated and normalized into internal source-control events, durable workflows generate revision-aware documentation, preview channels remain separate from the published channel, and GitHub Check Runs report the result. Public repositories remain represented in policy and contracts but are denied by configuration.

**Tech Stack:** TypeScript, Zod, Hono, Drizzle ORM, PostgreSQL, Cloudflare Workers, Queues, Workflows, Containers, R2, TanStack Router/Query, Vitest, GitHub Apps and Checks API.

## Global Constraints

- Do not begin Doxabot source changes until `2026-07-22-durable-generation-workflow.md` is reviewed, verified, and committed.
- Preserve all existing uncommitted durable-generation changes. Never fold them into a Doxabot commit.
- Support private repositories only in this release.
- Keep `DOXABOT_PUBLIC_REPOSITORIES_ENABLED=false` as the default and production value. The public-repository branch must remain testable for a future release, but no current UI or API may enable it.
- Keep `DOXABOT_ENABLED=false` until the final release gate is explicitly approved.
- A pull request may update only a preview channel. It must never advance `sites.publishedVersionId`.
- Only an observed update to the repository default branch may advance production documentation.
- Treat webhook delivery, queue delivery, and workflow invocation as at-least-once. Every boundary must be idempotent.
- Use GitHub Check Runs for status and preview links. Do not post pull-request comments.
- Do not send the whole repository to a model when a verified prior generation state exists. Diff revisions locally and regenerate only affected documentation pages.
- Keep source-control provider types out of core generation modules. GitHub-specific payloads and API calls stay in an adapter.
- Use strict TypeScript, Zod validation at external boundaries, explicit domain errors, dependency injection, and focused modules. Do not add `any`, unsafe type assertions, placeholder implementations, or speculative abstractions.
- Database migrations, production Wrangler bindings, queue settings, and public rollout flags require an explicit review checkpoint before they are applied.

---

## Delivery Sequence

Each phase has its own detailed plan and ends in a clean reviewable commit series. Do not start the next phase until the preceding phase is reviewed and committed.

### Phase 0: Prerequisite gate

- [ ] Finish and review `docs/superpowers/plans/2026-07-22-durable-generation-workflow.md`.
- [ ] Run its complete verification suite.
- [ ] Commit that work independently.
- [ ] Rebase the Doxabot file lists in the detailed plans against the resulting checkout and amend paths only where the prerequisite changed them.

### Phase 1: Security and private-only policy

Follow `docs/superpowers/plans/2026-07-22-doxabot-security-policy-foundation.md`.

Exit criteria:

- Hosted agents cannot execute a shell or read outside the checkout.
- Git credentials do not appear in process arguments, remote configuration, logs, or persisted artifacts.
- GitHub webhook verification fails closed.
- Doxabot eligibility is provider-neutral, deterministic, and denies public repositories by default.

### Phase 2: GitHub control plane

Follow `docs/superpowers/plans/2026-07-22-doxabot-github-control-plane.md`.

Exit criteria:

- A project owner can inspect and enable Doxabot for an eligible private repository.
- Relevant GitHub deliveries are stored once, normalized, filtered, and enqueued once.
- Pull requests are accepted only when their base is the current default branch.
- GitHub Check Runs reflect queued, running, completed, failed, superseded, and action-required states.
- Public-repository deliveries are recorded as ignored and launch no work.

### Phase 3: Incremental preview generation

Follow `docs/superpowers/plans/2026-07-22-doxabot-incremental-preview-generation.md`.

Exit criteria:

- The workflow checks out exact baseline, base, and head revisions and computes a synthetic pull-request merge tree.
- Permanent generation state records page-to-source dependencies and generator fingerprints.
- The planner regenerates only affected pages and makes zero model calls for documentation-neutral changes.
- A completed pull-request workflow publishes an isolated preview hostname and never mutates the production pointer.

### Phase 4: Production promotion and operations

Follow `docs/superpowers/plans/2026-07-22-doxabot-production-promotion-operations.md`.

Exit criteria:

- Default-branch pushes are the sole automation authority for production publication.
- A byte-identical, fingerprint-compatible preview can be promoted without another model run.
- Changed production baselines invalidate or requeue open previews safely.
- Superseded runs stop work and cannot publish late output.
- Reconciliation, retention, metrics, DLQ handling, and rollout controls are documented and tested.

---

## Commit and Review Protocol

- [ ] Implement one numbered task from a detailed plan.
- [ ] Run the task-specific tests and typecheck listed in that task.
- [ ] Inspect `git diff --check` and the scoped diff.
- [ ] Commit only the files listed by that task using its proposed commit message.
- [ ] Stop for review before beginning the next numbered task.
- [ ] At each phase boundary, run the phase-wide verification command and record the results in the pull request.

## Deferred Features

The following are intentionally outside this roadmap:

- Public-repository enablement.
- Conversational instructions to revise a generated preview.
- Manual editing of a generated preview before merge.
- GitLab, Bitbucket, or other provider adapters.
- Pull-request comments, review annotations, or automatic source-code changes.
- Generating documentation for pull requests whose base is not the repository default branch.

The provider-neutral event, policy, review-run, and checkout contracts created here are the extension points for those later phases.

## External Design Constraints

- GitHub webhook signatures must be validated over the raw request body before payload processing: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
- Check Runs are created by a GitHub App and require repository `Checks: write` permission: https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks
- Cloudflare Queues deliver at least once by default, so delivery and job identifiers must be idempotency keys: https://developers.cloudflare.com/queues/reference/delivery-guarantees/
- Cloudflare Workflow steps can retry, so side effects must live inside named steps and remain idempotent: https://developers.cloudflare.com/workflows/build/rules-of-workflows/
