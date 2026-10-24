# Doxabot Incremental Preview Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate an isolated documentation preview for an eligible pull-request head by comparing exact source revisions, reusing durable generation state, and invoking the model only for affected documentation pages.

**Architecture:** A provider-neutral checkout specification tells the container which revisions to fetch and merge. The container computes the exact source tree and local diff. Durable generation state stores source hashes, analysis, structure, page artifacts, and per-page source dependencies under immutable version prefixes in R2. The existing incremental planner selects regenerated versus reused pages. Completion writes a staged documentation version and atomically advances only the pull-request preview channel.

**Tech Stack:** TypeScript, Zod, Git CLI, Cloudflare Workflows, Containers, R2, PostgreSQL, Vitest.

## Global Constraints

- Complete and commit the GitHub control plane first.
- Build on the committed durable-generation workflow; do not reintroduce a separate non-durable PR pipeline.
- Fetch and operate on exact revision SHAs. Never assume the current default-branch tip or pull-request head is unchanged.
- A pull request is rendered from a synthetic merge with its base branch so the preview matches the code GitHub would merge.
- Never execute repository code, hooks, package managers, or build scripts.
- Every artifact read from R2 is untrusted serialized data and must pass a Zod schema.
- Transient workflow checkpoints and permanent generation state have different prefixes and lifecycles.
- Preview completion cannot update `docs_sites.published_version_id` in any transaction path.
- Keep every external side effect inside a named Workflow step and make it idempotent because a step may retry.

---

## Task 1: Define revision checkout, diff, and generation-state contracts

**Files:**

- Create: `packages/contracts/src/source-checkout.ts`
- Create: `packages/contracts/src/generation-state.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/generation/src/index.ts`
- Create: `packages/generation/tests/generation-state-contracts.test.ts`

- [ ] Define `SourceCheckoutSpec` as a discriminated union for `pull_request_merge` and `commit` checkouts.
- [ ] Require baseline revision, target/head revision, and base revision where relevant; validate full hexadecimal Git object IDs.
- [ ] Define `SourceChange` with normalized relative path, optional previous path, and `added | modified | deleted | renamed` status.
- [ ] Define `RepositorySnapshot` with target revision, synthetic tree hash, and ordered source changes.
- [ ] Define versioned permanent generation-state schemas for source-file hashes, reusable analysis, structure fingerprint, page dependency evidence, page content hash/artifact key, generator fingerprint, and source tree hash.
- [ ] Extend staged runtime page output with validated dependency state instead of a parallel untyped metadata channel.
- [ ] Test schema round trips, version rejection, path normalization rejection, malformed object IDs, rename data, and deterministic ordering.
- [ ] Run `pnpm --filter @doxahq/generation test -- generation-state-contracts`, `pnpm --filter @doxahq/contracts typecheck`, and `pnpm --filter @doxahq/generation typecheck`.
- [ ] Commit: `feat(doxabot): define revision and generation state contracts`

## Task 2: Prepare an exact pull-request repository snapshot

**Files:**

- Create: `apps/agent-container/src/repository-snapshot.ts`
- Create: `apps/agent-container/tests/repository-snapshot.test.ts`
- Modify: `apps/agent-container/src/git.ts`
- Modify: `apps/agent-container/src/staged-generation.ts`

- [ ] Create local bare-repository fixtures covering a clean merge, merge conflict, file deletion, binary change, and rename.
- [ ] Implement `prepareRepositorySnapshot(checkoutSpec, credentials, destination)` using `git init`, exact SHA fetches, detached worktrees, and disabled hooks.
- [ ] For GitHub pull requests, fetch the base repository's `refs/pull/<number>/head` reference and verify its object ID equals the accepted head SHA. This keeps private fork pull requests scoped to the installation on the base repository.
- [ ] For a pull request, create a synthetic merge tree without committing or executing project code. Return a typed `merge_conflict` domain result when Git cannot merge.
- [ ] Compute the source tree hash with Git and parse `git diff --name-status -z` from the published baseline tree to the synthetic target tree.
- [ ] Normalize and sort changes deterministically. Treat binary files as changed metadata without reading their contents into prompts.
- [ ] Ensure the checkout remote remains credential-free and the checkout contains no Git credential artifacts.
- [ ] Change staged generation to receive a prepared snapshot rather than recloning the repository independently for analysis, structure, and page batches.
- [ ] Run `pnpm --filter @doxahq/agent-container test -- repository-snapshot` and `pnpm --filter @doxahq/agent-container typecheck`.
- [ ] Commit: `feat(container): prepare exact source snapshots`

## Task 3: Add a validated permanent generation-state store

**Files:**

- Create: `apps/agent-worker/src/generation-state-store.ts`
- Create: `apps/agent-worker/tests/generation-state-store.test.ts`
- Modify: `apps/agent-worker/src/index.ts`
- Modify: `apps/agent-worker/src/generation-workflow-entrypoint.ts`

- [ ] Define immutable keys under `sites/<siteId>/generation-state/<versionId>/` for the manifest, analysis, structure, and page records.
- [ ] Keep transient retry checkpoints under `_generation-checkpoints/<jobId>/`; never use them as a published baseline.
- [ ] Implement validated reads that return a typed incompatible-or-missing result for old versions rather than partially trusting data.
- [ ] Implement writes as artifact writes followed by one manifest write. The manifest is the completion marker.
- [ ] Persist generator fingerprint, source tree hash, source revision, schema version, and page artifact hashes in the manifest.
- [ ] Verify hashes when loading referenced state objects and reject cross-site/version keys.
- [ ] Retain permanent state when transient workflow checkpoints are deleted.
- [ ] Test corrupt JSON, unsupported versions, incomplete writes, wrong hash, wrong prefix, missing baseline, and valid state reuse.
- [ ] Run `pnpm --filter @doxahq/agent-worker test -- generation-state-store` and `pnpm --filter @doxahq/agent-worker typecheck`.
- [ ] Commit: `feat(worker): persist validated generation state`

## Task 4: Capture page-to-source dependency evidence

**Files:**

- Modify: `packages/agent/src/state/types.ts`
- Modify: `packages/agent/src/state/page-targets.ts`
- Modify: `packages/agent/src/doxa-agent/generation-service.ts`
- Modify: `packages/agent/src/doxa-agent/index.ts`
- Create: `packages/agent/tests/page-dependency-state.test.ts`

- [ ] Add tests showing that a generated page records normalized source files read, source files discovered, referenced symbols/routes, and its final content hash.
- [ ] Consolidate existing page target/dependency representations into the versioned contract rather than duplicating source-of-truth types.
- [ ] Record dependencies through tool execution and generation context, not by asking the model to self-report a free-form list.
- [ ] Make partial page generation return page content and dependency state together.
- [ ] Ensure deleted and renamed source files remain matchable against prior dependency state.
- [ ] Sort and deduplicate every dependency list before hashing or persistence.
- [ ] Run `pnpm --filter @doxahq/agent test -- page-dependency-state`, `pnpm --filter @doxahq/agent test`, and `pnpm --filter @doxahq/agent typecheck`.
- [ ] Commit: `feat(agent): capture documentation source dependencies`

## Task 5: Reuse cached analysis and structure when safe

**Files:**

- Modify: `packages/agent/src/state/planning.ts`
- Modify: `packages/agent/src/state/source-changes.ts`
- Modify: `packages/agent/src/doxa-agent/generation-service.ts`
- Modify: `apps/agent-container/src/staged-generation.ts`
- Create: `packages/agent/tests/incremental-analysis.test.ts`

- [ ] Write cases for documentation-neutral changes, local page-impact changes, global structural changes, deleted dependencies, renamed dependencies, missing state, and generator fingerprint changes.
- [ ] Accept prior validated analysis, structure, source hashes, and normalized source changes at the analysis stage.
- [ ] Reuse unchanged source summaries and analyze only added or changed relevant files.
- [ ] Define a deterministic structural fingerprint from route/config/schema/package signals. Reuse structure only when that fingerprint and generator fingerprint remain compatible.
- [ ] Fall back to full analysis and structure planning when state is absent, invalid, incompatible, or affected by a structural change.
- [ ] Produce an explicit plan with `regeneratePageIds`, `reusePageIds`, `removedPageIds`, `modelCallsRequired`, and human-readable reasons.
- [ ] Guarantee `modelCallsRequired=false` for a verified documentation-neutral change.
- [ ] Run `pnpm --filter @doxahq/agent test -- incremental-analysis planning`, `pnpm --filter @doxahq/agent typecheck`, and `pnpm --filter @doxahq/agent-container typecheck`.
- [ ] Commit: `feat(agent): plan revision-aware incremental generation`

## Task 6: Execute only affected page batches and assemble reused artifacts

**Files:**

- Modify: `apps/agent-worker/src/generation-workflow-entrypoint.ts`
- Modify: `apps/agent-worker/src/generation-workflow.ts`
- Modify: `apps/agent-worker/src/workflow-stage-client.ts`
- Modify: `apps/agent-container/src/staged-generation.ts`
- Create: `apps/agent-worker/tests/incremental-generation-workflow.test.ts`

- [ ] Load the published baseline state before analysis and pass only validated reusable state to the container.
- [ ] Re-fetch or query the current pull-request head through the internal API before expensive work; mark the job superseded if it no longer matches.
- [ ] Stop with action required on a synthetic merge conflict and update the review run without creating a preview version.
- [ ] Skip write stages entirely when the plan requires no model calls.
- [ ] Batch only `regeneratePageIds`; load and verify `reusePageIds` from the baseline version.
- [ ] Assemble output in structure order, reject duplicate/missing/unexpected pages, and exclude removed pages.
- [ ] Persist the new permanent generation state before completion and report regenerated/reused counts.
- [ ] Test no-impact, one-page impact, global impact, corrupt reusable page, merge conflict, stale head, replay after checkpoint, and a failure after state artifacts but before manifest.
- [ ] Run `pnpm --filter @doxahq/agent-worker test -- incremental-generation-workflow`, `pnpm --filter @doxahq/agent-worker test`, and `pnpm --filter @doxahq/agent-worker typecheck`.
- [ ] Commit: `feat(worker): execute incremental documentation plans`

## Task 7: Publish isolated preview versions and hostnames

**Files:**

- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/services/internal-api.ts`
- Modify: `apps/api/src/routes/internal.ts`
- Modify: `apps/api/src/repositories/docs.ts`
- Modify: `apps/api/src/repositories/preview-channels.ts`
- Modify: `apps/api/src/services/docs-host-resolution.ts`
- Modify: `apps/docs-runtime/src/runtime-source.ts`
- Modify: `apps/agent-worker/src/generation-workflow-entrypoint.ts`
- Create: `apps/api/tests/services/preview-publication.test.ts`
- Create: `apps/docs-runtime/tests/preview-resolution.test.ts`

- [ ] Replace the workflow-facing `publishJobOutput` contract with `completeJobOutput`, discriminated by `publicationMode: publish | preview`.
- [ ] Generate a stable normalized hostname such as `<project-slug>-pr-<number>.docs.doxa.so`, with database uniqueness as the authority for collision handling.
- [ ] In one transaction, insert the staged docs version, verify job/head/tree identity, and compare-and-set the preview channel pointer.
- [ ] Prove in repository tests that the preview branch has no code path that updates `docsSites.publishedVersionId`.
- [ ] Resolve preview hostnames through preview-channel state while leaving custom-domain and published-host behavior unchanged.
- [ ] Update the GitHub Check Run with success, preview URL, source-change count, regenerated page count, and reused page count.
- [ ] On failure, leave the prior successful preview pointer intact and complete the new Check Run as failure.
- [ ] Test first preview, updated head, duplicate completion, stale late completion, hostname collision, runtime resolution, and production-pointer isolation.
- [ ] Run `pnpm --filter @doxahq/api test -- preview-publication`, `pnpm --filter @doxahq/docs-runtime test -- preview-resolution`, and relevant typechecks/builds.
- [ ] Commit: `feat(doxabot): publish isolated pull request previews`

---

## Phase Verification

- [ ] Run `pnpm test`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm build`.
- [ ] Run `git diff --check`.
- [ ] Run a deterministic private-repository fixture through initial publication, a one-file pull request, and a documentation-neutral update.
- [ ] Verify the one-file update regenerates only expected pages, the neutral update makes zero model calls, and neither changes the published version pointer.
