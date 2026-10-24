# Generation Model Routing, Cost Telemetry, and MDX Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Route planning and writing through separately configurable Nitro models, persist internal usage and failed-page diagnostics, and repair local MDX syntax errors without full-page regeneration.

**Architecture:** The API snapshots a typed two-model configuration and stage fingerprints into every job. Container stages emit request-scoped usage and diagnostic stream records; the Worker persists them through internal-only RPCs, writes failed drafts to private R2, and logs summaries only to the terminal. A versioned writer handoff separates planning from writing, while a deterministic-first repair engine applies bounded local MDX patches and revalidates the complete page.

**Tech Stack:** TypeScript, Zod, TanStack AI, OpenRouter, Cloudflare Workers/Workflows/Containers/R2, PostgreSQL, Drizzle ORM, Vitest.

## Global Constraints

- Planner default: `x-ai/grok-4.5:nitro`.
- Writer and repair default: `moonshotai/kimi-k2.6:nitro`.
- Do not add cost or diagnostic information to job events, customer APIs, dashboard components, or web application code.
- Persist model configuration at admission and execute from the persisted values, never the Worker's current environment.
- Failed drafts expire after seven days, structured diagnostics after 30 days, and usage records after 90 days.
- Keep failed drafts under a private `_generation-diagnostics/` R2 prefix.
- Treat model-call IDs as idempotency keys for delivery, not provider retry groups.
- Preserve unrelated and pre-existing uncommitted changes.
- Do not commit until the user explicitly requests it.

---

### Task 1: Define stage-model, handoff, telemetry, and diagnostic contracts

**Files:**

- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/generation-observability.ts`
- Create: `packages/contracts/src/writer-handoff.ts`
- Test: `packages/generation/tests/generation-observability-contracts.test.ts`

**Interfaces:**

- Produces: `GenerationModelConfig`, `GenerationUsageRecord`,
  `GenerationUsageSummary`, `GenerationRepairDiagnostic`,
  `WriterHandoffManifest`, and new stage-stream `usage`/`diagnostic` records.
- Consumes: existing `GenerationProfile`, page dependency, stage request, and
  stage result contracts.

- [x] Write failing schema tests for both model roles, strict usage records,
  bounded diagnostic fields, writer handoff page uniqueness, and stage-stream
  usage/diagnostic records.
- [x] Run
  `pnpm --filter @doxahq/generation test -- generation-observability-contracts`
  and confirm the new exports/schemas are missing.
- [x] Add strict Zod schemas and exported inferred types. Replace the stage
  request's single `model` with `modelConfig` plus a stage-selected `model`.
  Extend the structure result/request flow with `writerHandoff`.
- [x] Add diagnostic draft maximums and explicit nullable provider fields;
  reject negative token counts, non-finite costs, invalid timestamps, duplicate
  handoff page IDs, and repair offsets outside the draft.
- [x] Re-run the focused test and package typechecks.

### Task 2: Persist immutable model roles, fingerprints, usage, and diagnostics

**Files:**

- Modify: `packages/db/src/schema/doxa.ts`
- Create: `packages/db/migrations/0013_generation_observability_and_models.sql`
- Modify: `packages/db/migrations/meta/_journal.json`
- Generate: `packages/db/migrations/meta/0013_snapshot.json`
- Modify: `apps/api/src/repositories/jobs.ts`
- Create: `apps/api/src/repositories/generation-observability.ts`
- Modify: `apps/api/src/services/internal-api.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `apps/api/tests/repositories/jobs.test.ts`
- Create: `apps/api/tests/repositories/generation-observability.test.ts`

**Interfaces:**

- Consumes: Task 1 records and model configuration.
- Produces:
  `GenerationObservabilityRepository.recordUsage(record)`,
  `recordDiagnostic(metadata)`, `getUsageSummary(jobId)`, and
  `deleteExpired(now, limit)`, plus matching internal RPCs.

- [x] Write failing repository tests proving model-pair persistence, usage
  `callId` idempotency, separate counting of distinct calls, precise cost
  aggregation, diagnostic metadata without draft bodies, and bounded retention
  deletion.
- [x] Run the focused API repository tests and confirm they fail for missing
  schema/repository behavior.
- [x] Add `planner_model`, `writer_model`, `planning_fingerprint`, and
  `writing_fingerprint` job columns. Keep `agent_model` readable only for
  migration compatibility.
- [x] Add `generation_usage_records` keyed by `call_id`, with stage/page/attempt
  attribution, token columns, numeric cost columns, provider IDs, and
  `expires_at`.
- [x] Add `generation_repair_diagnostics` keyed by `diagnostic_id`, with parser
  details, draft key/hash/truncation, repair outcome, and `expires_at`.
- [x] Implement repository upserts, summaries, and bounded cleanup. Add
  internal-only RPC methods; do not add public routes or DTO fields.
- [x] Generate/verify Drizzle migration metadata and run focused tests plus
  `pnpm --filter @doxahq/db typecheck`.

### Task 3: Resolve and execute immutable stage-specific Nitro models

**Files:**

- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/src/services/generation-execution-config.ts`
- Modify: `apps/api/src/services/doxabot/webhook-orchestrator.ts`
- Modify: production generation admission/service files located by
  `rg "resolveGenerationExecutionConfig" apps/api/src`
- Modify: `apps/api/.dev.vars.example`
- Modify: `apps/api/wrangler.json`
- Modify: `apps/agent-worker/src/index.ts`
- Modify: `apps/agent-worker/src/generation-workflow.ts`
- Modify: `apps/agent-worker/src/generation-workflow-entrypoint.ts`
- Modify: `apps/agent-worker/wrangler.json`
- Modify: `apps/agent-container/src/staged-generation.ts`
- Modify: `packages/agent/src/doxa-agent/constants.ts`
- Test: `apps/api/tests/services/doxabot-webhook-orchestrator.test.ts`
- Test: `apps/api/tests/services/production-generation-admission.test.ts`
- Test: `apps/agent-worker/tests/incremental-generation-workflow.test.ts`
- Test: `apps/agent-container/tests/staged-generation.test.ts`

**Interfaces:**

- Consumes: persisted model roles/fingerprints from Task 2.
- Produces:
  `resolveGenerationExecutionConfig(env): GenerationExecutionConfig` and
  `modelForStage(config, stage): string`.

- [x] Write failing tests for Nitro defaults, explicit overrides, legacy
  `DOXA_AGENT_MODEL` fallback, immutable job values after environment changes,
  planner routing for analysis/structure, and writer routing for write.
- [x] Run the focused API, Worker, and container tests and verify the expected
  single-model failures.
- [x] Resolve `DOXA_PLANNER_MODEL` and `DOXA_WRITER_MODEL`; compute separate
  planning/writing fingerprints and a combined generator fingerprint.
- [x] Persist all resolved values on manual and Doxabot jobs. Make the Worker
  build stage requests from `prepared.context.job`, not Worker environment
  model/profile values.
- [x] Select the stage model explicitly and include both roles in boot logs.
  Keep repair bound to the writer model.
- [x] Update example/production Wrangler configuration with both Nitro model
  IDs and remove the superseded Luna-only default.
- [x] Run focused tests and relevant typechecks.

### Task 4: Add a versioned planner-to-writer handoff

**Files:**

- Create: `packages/agent/src/doxa-agent/writer-handoff.ts`
- Modify: `packages/agent/src/doxa-agent/prompts/dynamic/types.ts`
- Modify: `packages/agent/src/doxa-agent/prompts/dynamic/builders.ts`
- Modify: `packages/agent/src/doxa-agent/generation-service.ts`
- Modify: `apps/agent-container/src/staged-generation.ts`
- Test: `packages/agent/tests/writer-handoff.test.ts`
- Test: `packages/agent/tests/prompts.test.ts`
- Test: `apps/agent-container/tests/staged-generation.test.ts`

**Interfaces:**

- Consumes: accepted analysis, documentation structure, source revision, project
  identity, and page dependency/reference data.
- Produces:
  `buildWriterHandoff(input): WriterHandoffManifest` and
  `selectWriterPageBriefs(handoff, pageIds)`.

- [x] Write failing tests proving deterministic handoff ordering, exact
  page-brief selection, required evidence/constraints, and a writer prompt that
  forbids structure redesign and unsupported facts.
- [x] Run focused tests and confirm the missing handoff behavior.
- [x] Build the manifest deterministically at structure completion and return it
  in the structure stage result.
- [x] Pass the manifest into write stage requests/checkpoints and inject only
  shared constraints plus requested page briefs into writer context.
- [x] Include the handoff schema/prompt version in `writingFingerprint`.
- [x] Run focused tests and agent/container typechecks.

### Task 5: Replace global hosted usage capture with request-scoped telemetry

**Files:**

- Modify: `packages/agent/src/core/types.ts`
- Modify: `packages/agent/src/core/usage.ts`
- Modify: `packages/agent/src/core/agent.ts`
- Modify: `packages/agent/src/types.ts`
- Modify: `packages/agent/src/doxa-agent/writer-pipeline.ts`
- Modify: `packages/agent/src/doxa-agent/writer.ts`
- Modify: analysis/structure call sites found by
  `rg "run\\(|stream\\(" packages/agent/src/doxa-agent`
- Test: `packages/agent/tests/tanstack-runtime.test.ts`
- Create: `packages/agent/tests/generation-usage.test.ts`

**Interfaces:**

- Consumes: Task 1 `GenerationUsageRecord` metadata shape.
- Produces:
  `AgentOptions.onUsage(record)`, `AgentConfig.usageContext`, and per-operation
  scoped metadata for analysis, structure, writing, and repair.

- [x] Write failing tests demonstrating concurrent agent runs do not observe
  each other's usage, every TanStack iteration is recorded once, page attempts
  are attributed correctly, and legacy provider calls use the same callback.
- [x] Run focused agent tests and observe failures caused by the current global
  subscriber path.
- [x] Extend token usage mapping with cached, cache-write, reasoning, and
  upstream cost details when provided.
- [x] Generate a stable call ID before each model request/iteration and invoke
  only the current request's callback.
- [x] Keep the existing dev cost tracker working through an explicit local
  adapter; hosted generation must not subscribe globally.
- [x] Thread operation/page/retry/attempt context through writer and planning
  calls without mutable process state.
- [x] Run focused tests and the complete agent test suite.

### Task 6: Stream, persist, and log internal telemetry and diagnostics

**Files:**

- Modify: `apps/agent-container/src/index.ts`
- Modify: `apps/agent-container/src/staged-generation.ts`
- Modify: `apps/agent-worker/src/workflow-stage-client.ts`
- Create: `apps/agent-worker/src/generation-observability.ts`
- Modify: `apps/agent-worker/src/generation-workflow-entrypoint.ts`
- Modify: `apps/agent-worker/src/index.ts`
- Test: `apps/agent-container/tests/staged-generation.test.ts`
- Test: `apps/agent-worker/tests/workflow-stage-client.test.ts`
- Create: `apps/agent-worker/tests/generation-observability.test.ts`

**Interfaces:**

- Consumes: Task 1 stream records and Task 2 internal RPC methods.
- Produces: `GenerationObservabilitySink`, terminal stage/job summary logs, R2
  diagnostic draft storage, and scheduled retention cleanup.

- [x] Write failing tests for usage/diagnostic stream callbacks, R2 key
  containment, 256-KiB draft truncation, RPC idempotency, stage summaries,
  failure summaries, and absence of `addJobEvent`.
- [x] Run focused tests and confirm the current stream rejects the new records.
- [x] Buffer only bounded current-stage usage metadata in the container and emit
  records before `stage_result` or `error`.
- [x] Persist usage immediately in the Worker. Persist diagnostic metadata after
  writing the bounded draft to the private R2 prefix.
- [x] Log per-stage summaries and query/log a final job summary on success,
  failure, or cancellation. Never forward these records through
  `StageEventForwarder`.
- [x] Extend the scheduled handler to delete expired database metadata in
  bounded batches. Document the seven-day R2 prefix lifecycle command.
- [x] Run focused Worker/container tests and typechecks.

### Task 7: Implement deterministic and bounded model MDX repair

**Files:**

- Create: `packages/agent/src/utils/mdx-repair.ts`
- Create: `packages/agent/src/doxa-agent/mdx-repair-model.ts`
- Modify: `packages/agent/src/doxa-agent/writer-pipeline.ts`
- Modify: `packages/agent/src/doxa-agent/writer.ts`
- Modify: `packages/agent/src/types.ts`
- Modify: `packages/agent/src/utils/page-validator.ts`
- Test: `packages/agent/tests/mdx-repair.test.ts`
- Modify: `packages/agent/tests/writer-repair.test.ts`

**Interfaces:**

- Consumes: exact `ToolValidationIssue` parser locations and Task 5 usage
  callback.
- Produces:
  `repairMdxDeterministically(input): MdxRepairResult`,
  `requestMdxRepairPatch(input): Promise<MdxRepairPatch>`, and writer
  diagnostic events containing the failed draft and repair result.

- [x] Write failing fixtures for raw prose `<`, invalid ampersand/braces,
  untouched fenced/inline code, untouched valid JSX, multi-byte line/column
  conversion, stale draft hashes, oversized/off-location model patches, repair
  revalidation, and two-attempt exhaustion.
- [x] Run `pnpm --filter @doxahq/agent test -- mdx-repair writer-repair` and
  verify failures are due to missing repair behavior.
- [x] Implement parser-location-to-offset conversion and lexical context
  detection for frontmatter, fenced code, inline code, and JSX.
- [x] Add a narrow deterministic replacement registry and revalidate the entire
  composed page after every edit.
- [x] Implement writer-model JSON patch generation with strict Zod parsing,
  draft SHA preconditions, overlap/span limits, and at most two model attempts.
- [x] Invoke targeted repair before whole-page retry for local parser-only
  failures. Do not regenerate the full page when the local repair budget is
  exhausted; throw with preserved diagnostics.
- [x] Run focused and full agent tests plus typecheck.

### Task 8: End-to-end retention, isolation, and regression verification

**Files:**

- Modify: `docs/generation-observability.md`
- Modify: relevant local-development documentation found by
  `rg "DOXA_AGENT_MODEL|OPENROUTER" docs apps -g '*.md'`
- Test: existing API, Worker, container, generation, and agent suites

**Interfaces:**

- Consumes: all previous tasks.
- Produces: operator instructions for switching model pairs, reading terminal
  summaries, querying internal records, and configuring R2 lifecycle retention.

- [x] Add a regression test that runs an admitted job after changing Worker
  environment values and confirms the persisted planner/writer pair wins.
- [x] Add a regression test proving usage and diagnostics are absent from job
  events and public generation responses.
- [x] Add a staged-generation fixture where an `unexpected-character` page is
  repaired locally and the writer provider is not asked to regenerate it.
- [x] Document model variables, terminal event shapes, retention windows,
  missing-cost semantics, and the exact prefix-scoped R2 lifecycle command.
- [x] Run focused suites:
  `pnpm --filter @doxahq/agent test`,
  `pnpm --filter @doxahq/agent-container test`,
  `pnpm --filter @doxahq/agent-worker test`, and
  `pnpm --filter @doxahq/api test`.
- [x] Run `pnpm typecheck`, `pnpm build`, and `git diff --check`.
- [x] Inspect `git status --short` and verify no customer dashboard/web files
  changed and no unrelated work was staged or committed.
