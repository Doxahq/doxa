# Durable Documentation Generation Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make large documentation generations reliable by checkpointing analysis, structure, and page batches in a Cloudflare Workflow while retaining bounded stage-aware execution for local inline generation.

**Architecture:** The Queue consumer becomes a short admission layer that creates one Workflow instance per generation job. The Workflow invokes explicit streaming agent-container stages, stores opaque analysis/structure/page checkpoints in R2, retries only failed stages, assembles and publishes artifacts atomically, and removes checkpoints. Local inline generation continues to use the existing single request but receives independent analysis, structure, workload-sized writing, finalization, idle, and overall deadlines.

**Tech Stack:** TypeScript, Cloudflare Workers/Queues/Workflows/Containers/R2, Zod, Vitest, pnpm.

## Global Constraints

- Preserve the existing 90-second transport-idle timeout and job-scoped cancellation behavior.
- Never persist GitHub installation tokens or OpenRouter API keys in Workflow state, R2 checkpoints, events, or logs.
- Keep publication atomic: no artifact upload or publish after cancellation or partial page generation.
- Keep the current 100-page experiment intact; reliability must come from bounded batching rather than silently truncating the requested structure.
- Queue messages remain at-least-once; Workflow instance ID is the generation job ID for idempotent admission.
- Workflow step returns contain only bounded metadata and R2 keys; opaque analysis, structure, and page payloads live in R2.
- Existing local `container-inline` behavior remains supported.

---

### Task 1: Workload planning and local stage deadlines

**Files:**
- Create: `packages/generation/src/generation-budget.ts`
- Modify: `packages/generation/src/index.ts`
- Modify: `packages/generation/tests/index.test.ts`

**Interfaces:**
- Produces: `planPageBatches(pageIds, concurrency)`, `writingStageTimeoutMs(pageCount, concurrency, batchTimeoutMs, finalizeTimeoutMs)`, and stage deadline configuration consumed by local inline generation and Workflow orchestration.

- [ ] Write failing tests proving 78 pages at concurrency 6 creates 13 deterministic batches and a writing budget sized from 13 batch allowances.
- [ ] Write failing coordinator tests proving semantic stage transitions replace the current stage deadline while healthy heartbeats reset only the idle deadline.
- [ ] Implement the pure workload planner and a resettable stage deadline raced alongside the independent overall and idle deadlines.
- [ ] Emit stage-specific timeout errors containing the stage and configured duration.
- [ ] Run `pnpm --filter @doxahq/generation test` and confirm all tests pass.

### Task 2: Serializable stage transport contracts

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/tsconfig.json` only if required by generated types.
- Test: `apps/agent-container/tests/worker-core.test.ts`

**Interfaces:**
- Produces: Zod schemas/types for `analysis`, `structure`, and `write` stage requests plus heartbeat/event/result/error NDJSON records.
- Checkpoints are opaque JSON strings; page results expose only `id`, `title`, `route`, `navigationPath`, and `content`.

- [ ] Add failing routing/schema tests for all three stage request kinds and invalid payload rejection.
- [ ] Implement discriminated request/result schemas without importing `@doxahq/agent` into contracts.
- [ ] Run contracts typecheck and agent-container routing tests.

### Task 3: Partial page generation

**Files:**
- Modify: `packages/agent/src/doxa-agent/generation-service.ts`
- Modify: `packages/agent/src/types.ts`
- Test: `packages/agent/tests/generation.test.ts`

**Interfaces:**
- Produces: optional `GenerationExecutionOptions { pageIds?: string[]; finalize?: boolean }` accepted by `generateDocumentation`.
- A partial batch uses the full route registry but writes and validates only requested pages, allows links to planned routes, and skips whole-document pruning/navigation finalization.

- [ ] Write a failing test proving a selected page-ID batch writes only requested pages while preserving full-structure routes.
- [ ] Implement page filtering and partial-quality semantics.
- [ ] Keep full-generation behavior byte-for-byte compatible when options are omitted.
- [ ] Run the package agent suite.

### Task 4: Agent-container stage endpoints

**Files:**
- Create: `apps/agent-container/src/staged-generation.ts`
- Modify: `apps/agent-container/src/index.ts`
- Modify: `apps/agent-container/src/local-http-server.ts`
- Modify: `apps/agent-container/src/worker-core.ts`
- Test: `apps/agent-container/tests/staged-generation.test.ts`
- Test: `apps/agent-container/tests/local-http-server.test.ts`
- Test: `apps/agent-container/tests/worker-core.test.ts`

**Interfaces:**
- Produces streaming endpoints `/stages/analyze/stream`, `/stages/structure/stream`, and `/stages/write/stream`.
- Analyze returns an opaque analysis checkpoint.
- Structure returns an opaque structure checkpoint, ordered page IDs, and deterministic navigation metadata.
- Write returns validated runtime page inputs for one requested batch.

- [ ] Write failing tests for stage routing, heartbeat-safe streaming, checkpoint parsing, deterministic page order, and batch-only writes.
- [ ] Extract shared clone/config/event setup from the monolithic generation path without changing `/generate/stream` behavior.
- [ ] Implement each stage with request cancellation propagated to clone/model/retry work.
- [ ] Run all agent-container tests.

### Task 5: Durable Workflow coordinator and R2 checkpoints

**Files:**
- Create: `apps/agent-worker/src/generation-workflow.ts`
- Create: `apps/agent-worker/src/stage-client.ts`
- Create: `apps/agent-worker/src/checkpoints.ts`
- Modify: `apps/agent-worker/src/index.ts`
- Modify: `apps/agent-worker/wrangler.json`
- Test: `apps/agent-worker/tests/generation-workflow.test.ts`
- Test: `apps/agent-worker/tests/index.test.ts`

**Interfaces:**
- Produces exported `GenerationWorkflow extends WorkflowEntrypoint<Env, GenerateJobMessage>` and a `GENERATION_WORKFLOW` binding.
- Queue admission calls `GENERATION_WORKFLOW.create({ id: jobId, params: message.body })`; duplicate-instance admission is treated as success.
- Checkpoint keys use `_generation-checkpoints/{jobId}/{stage-or-batch}.json`.

- [ ] Replace the queue execution test with a failing admission test that expects Workflow creation and immediate acknowledgement.
- [ ] Add failing Workflow tests for prepare, analysis checkpoint, structure checkpoint, deterministic batch steps, atomic publish, cancellation, retryable infrastructure failure, non-retryable generation failure, and cleanup.
- [ ] Implement a streaming stage client with independent idle and step deadlines and sanitized persisted events.
- [ ] Implement R2 checkpoint put/get/list/delete helpers with strict key prefixes.
- [ ] Implement Workflow steps with deterministic names, bounded retry policies, and only R2 keys in step outputs.
- [ ] Assemble runtime artifacts after every requested page ID appears exactly once; reuse existing artifact validation/publication boundaries.
- [ ] Run agent-worker tests and typecheck.

### Task 6: Capacity alignment, local defaults, and documentation

**Files:**
- Modify: `apps/agent-container/wrangler.json`
- Modify: `apps/agent-worker/wrangler.json`
- Modify: `apps/api/wrangler.json`
- Modify: `apps/api/.dev.vars.example`
- Modify: `docs/generation-observability.md`
- Modify: `README.md` if generation-mode documentation requires it.

**Interfaces:**
- Produces aligned container capacity and documented variables for overall, idle, analysis, structure, page-batch, and finalization budgets.

- [ ] Align production `max_instances` with the intended maximum active Workflow/container count and retain bounded retries when capacity is temporarily exhausted.
- [ ] Configure local inline overall timeout separately from per-stage budgets.
- [ ] Document Workflow checkpoint events, cleanup, timeout meanings, and the rule that concurrency changes require latency/rate-limit evidence.
- [ ] Validate Wrangler config against the installed schema and run `wrangler types`/typecheck.

### Task 7: Full verification

**Files:**
- Modify only files required by failing verification.

**Interfaces:**
- Produces a verified, reviewable dirty-worktree handoff without committing user-owned changes.

- [ ] Run focused tests after each task.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm build`, and `git diff --check`.
- [ ] Inspect `git diff --stat`, full diff, and status for unrelated changes or secrets.
- [ ] Confirm no generation checkpoint, artifact, database, or deployment mutation occurred during tests.
