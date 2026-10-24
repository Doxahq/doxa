# Docs Generation Pipeline Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks are ordered by dependency; do not reorder without re-reading the dependency table.

**Goal:** Cut cold-start (no reusable state) documentation generation wall time by removing serialization, subprocess churn, redundant retrieval, and uncached prompt prefixes from the hosted generation pipeline — without changing the produced documentation contract (structure, navigation, icons, groups, quality gates).

**Architecture:** Hosted generation runs as a Cloudflare Workflow (`apps/agent-worker/src/generation-workflow-runtime.ts`) that invokes a per-job container (`apps/agent-container/src/staged-generation.ts`) once per stage: `analysis` → `structure` → N × `write` batches → finalize/publish. The container calls the shared agent (`packages/agent`) which explores the repo, plans, and writes each page through a validated writer loop. This plan keeps the stage/checkpoint model intact and attacks the four cost centers inside it: (1) lock-step serialization at three levels, (2) per-page agentic retrieval round trips, (3) per-validation Node subprocess spawns, (4) an unstable prompt prefix that defeats provider prompt caching.

**Tech Stack:** TypeScript (ESM), Zod 4, Vitest 2, pnpm workspace, Cloudflare Workers/Workflows/Containers/R2, TanStack AI + OpenRouter, MDX (`@mdx-js/mdx`).

---

## Baseline Facts (verified against the working tree on 2026-07-29)

The working tree contains **uncommitted changes** from a concurrent agent that improved docs structure, navigation icons, and groups. All facts below were read from the **working tree**, not from `HEAD`. Line numbers were verified on 2026-07-29 20:05 CET — treat them as hints and locate the named symbol rather than trusting the number.

| Fact | Location |
| --- | --- |
| Workflow writes page batches in a strictly sequential `for` loop (two call sites: default path and revision-aware path) | `apps/agent-worker/src/generation-workflow-runtime.ts:359`, `:760` |
| Default page concurrency 6; write-stage `pageIds` capped at 20 by contract | `apps/agent-worker/src/generation-workflow-runtime.ts:358`, `apps/agent-container/src/generation-profile.ts:14`, `packages/contracts/src/index.ts:429` |
| Container writes pages in lock-step slices, not a worker pool | `packages/agent/src/doxa-agent/generation-service.ts:736` |
| Writer runs an agentic loop per page with `maxSteps: 12` and read-only tools + `validate_page` | `packages/agent/src/doxa-agent/writer.ts:537-549`, `:694-706` |
| Every MDX validation spawns a fresh `node` process that cold-imports `@mdx-js/mdx` | `packages/agent/src/utils/mdx-compile.ts:132`, `packages/agent/src/utils/runtime.ts:54`, `packages/agent/runtime/mdx-validator.mjs:1` |
| MDX validation is invoked from four places per page (model tool, pipeline gate, final compose check, quality repair) | `packages/agent/src/core/tools/validate-page.ts:48`, `packages/agent/src/doxa-agent/writer-pipeline.ts:352`, `packages/agent/src/doxa-agent/writer.ts:774`, `packages/agent/src/doxa-agent/generation-service.ts:831` |
| Writer user message puts page-specific text first and shared job-wide context after → unstable prompt prefix | `packages/agent/src/doxa-agent/prompts/dynamic/builders.ts:288` (generic variant at `:341`) |
| Writer **system** prompt is already page-independent (intro + modules + component playbook) | `packages/agent/src/doxa-agent/prompts/dynamic/composer.ts:24`, `prompts/dynamic/modules.ts:310+` |
| Docs-quality repair is a serial single-issue loop with a full revalidation per repair | `packages/agent/src/doxa-agent/generation-service.ts:831` |
| `Grep` tool has no `--exclude-dir`, no binary skip, and no timeout | `packages/agent/src/core/tools/grep.ts:23`, `packages/agent/src/utils/runtime.ts:62` |
| Repository snapshot is reused across stages via a marker file, and lives outside the per-stage root | `apps/agent-container/src/repository-snapshot.ts:85`, `apps/agent-container/src/workspace-layout.ts:31` |
| Per-stage root is keyed only by stage name and is deleted in `finally` | `apps/agent-container/src/workspace-layout.ts:28`, `apps/agent-container/src/staged-generation.ts:345` |
| Cancellation registry keyed by `jobId` holds exactly **one** controller — a second concurrent request for the same job overwrites it | `apps/agent-container/src/active-generation-requests.ts:5,15` |
| Container instance type is `standard-1` (½ vCPU), `max_instances: 5`, `sleepAfter = "2m"` | `apps/agent-container/wrangler.json:16` and `:48` (duplicated in `env.production`), `apps/agent-container/src/worker.ts:6` |
| Hosted write stage passes `cacheManager: undefined` — no page-level cache inside a job | `apps/agent-container/src/staged-generation.ts:309` |
| Revision-aware reuse already exists and is **not** part of this plan: preview/doxabot jobs load the baseline's generation state, plan `regeneratePageIds` vs `reusePageIds` from source deltas against per-page dependencies, and merge unchanged pages from the baseline's published artifacts | `apps/agent-worker/src/generation-workflow-runtime.ts:242` (path selection), `:1300` (`loadReusableState`), `:1403` (`loadReusablePages`), `packages/agent/src/state/planning.ts:191` |
| Legacy default path sends no `checkoutSpec`, so its analysis result carries no `sourceState` | `apps/agent-worker/src/generation-workflow-runtime.ts:1555` |
| `writingFingerprint` = `doxabot-writing-v1:<writerModel>:writer-handoff-v1` — the writer model is already inside it | `apps/api/src/services/generation-execution-config.ts:44` |
| Nav ordering model call is already removed from the hosted path (deterministic manifest) | `packages/agent/src/doxa-agent/nav-order.ts:63`, `apps/agent-container/src/staged-generation.ts:293` |
| `AgentUsageRecord.durationMs` exists and is plumbed to Postgres, but the TanStack path never populates it | `packages/agent/src/core/types.ts:204`, `packages/agent/src/core/agent.ts:301` (`doxa-usage` middleware), `packages/db/src/schema/doxa.ts:494` |
| Per-model-call deadline already exists (`DEFAULT_MODEL_CALL_TIMEOUT_MS = 120_000`) | `packages/agent/src/core/model-call-deadline.ts:3` |
| Planning/writing fingerprints replaced the single generator fingerprint | `apps/api/src/services/generation-execution-config.ts:7-49`, `packages/agent/src/state/planning.ts:191` |
| Deterministic end-to-end harness with a stubbed provider exists | `apps/agent-container/synthetic/runner.ts`, root script `pnpm test:generation:synthetic` |

**Before starting Task 1, re-verify the tree:**

```bash
cd doxa-platform
git status --short
git log --oneline -3
pnpm typecheck
pnpm test
```

If the uncommitted structure/icons/groups changes have been committed or extended since this plan was written, re-read the four files that matter most to this plan before editing them: `packages/agent/src/doxa-agent/generation-service.ts`, `packages/agent/src/doxa-agent/writer.ts`, `apps/agent-container/src/staged-generation.ts`, `apps/agent-worker/src/generation-workflow-runtime.ts`.

---

## Global Constraints

- **Do not change produced documentation output.** Structure, page routes, navigation sections/groups/icons/badges, and quality gates must remain byte-identical for the same inputs. Every task here is a latency change, not an editorial change. The only exceptions are the explicitly flagged behavior changes in Task 10 (writer retrieval mode) and Task 9 (repair ordering), both of which ship behind a config flag defaulting to current behavior until their acceptance gate passes.
- **Never revert or "clean up" the uncommitted structure/icons/groups work** already in the tree. If a file you must edit has uncommitted changes, integrate with them.
- **Fail-closed validation is non-negotiable.** Any MDX validator failure (timeout, crash, malformed output, pool exhaustion) must keep returning `ok: false` with a `validator-crashed` error. Never allow a silent pass.
- **Hard cancel must keep working.** `ActiveGenerationRequests.cancel(jobId)` must abort *every* in-flight request for that job after Task 4.
- **Determinism:** given the same inputs, the set and order of generated pages, the navigation manifest, and the failure/skip decisions must not depend on scheduling order. Tests must not rely on wall-clock timing; assert observed concurrency and call counts through injected fakes instead.
- **Tests stay local and deterministic** (`docs/testing-strategy.md`): no GitHub, OpenRouter, R2, or Postgres calls in default suites.
- **Ask first** (per `CLAUDE.md` guardrails) before: editing `apps/agent-container/wrangler.json` (instance type, max instances), changing `sleepAfter`, adding R2 lifecycle rules, or anything that changes hosted cost. Tasks that need this are marked **APPROVAL-GATED** and must stop and ask.
- **Do not commit.** Leave changes in the working tree for user review, per repo guardrails.
- Every task ends green: `pnpm typecheck` and the listed suites pass, and `pnpm test:generation:synthetic` still completes successfully.

---

## Task Order and Dependencies

| # | Task | Improvement | Depends on |
| --- | --- | --- | --- |
| 1 | Stage timing instrumentation | #11 | — |
| 2 | MDX validator worker pool | #4 | 1 (for measurement) |
| 3 | Continuous page worker pool in the container | #1a | 1 |
| 4 | Concurrency-safe container stage isolation | prerequisite | — |
| 5 | Parallel write-batch dispatch in the workflow | #1b | 3, 4 |
| 6 | Stable cached prompt prefix | #3 | — |
| 7 | Per-job tool-result cache + repo search hardening | #6 | — |
| 8 | Parallel docs-quality repair | #5 | 3 |
| 9 | Targeted repair before full page regeneration | #9 | 2 |
| 10 | Evidence-first single-shot writer | #2 | 6, 7 |
| 11 | Merge analysis + structure into one plan stage | #7 | 4 |
| 12 | Content-addressed page cache in R2 (two-tier, opt-in cross-model) | #8 | 5, 11 |
| 13 | Container capacity and sharding decision | #7b / throughput | 1, 2, 3, 5 |

Improvement #10 (incremental publish) is intentionally out of scope for this plan.

---

### Task 1: Stage timing instrumentation and perf baseline

**Why:** Every later task claims a speedup. Without a per-stage split of *model wall time vs tool wall time vs validation wall time vs container overhead*, none of them are verifiable and the wrong bottleneck gets optimized. `durationMs` already exists on `AgentUsageRecord` and reaches Postgres — it is simply never populated on the TanStack path.

**Files:**
- Modify: `packages/agent/src/core/agent.ts`
- Modify: `packages/agent/src/core/types.ts`
- Modify: `packages/agent/src/core/tool.ts`
- Modify: `packages/agent/src/core/index.ts`
- Modify: `packages/agent/src/utils/mdx-compile.ts`
- Create: `apps/agent-container/src/stage-timings.ts`
- Modify: `apps/agent-container/src/staged-generation.ts`
- Test: `packages/agent/tests/tanstack-runtime.test.ts`
- Test: `packages/agent/tests/mdx-compile.test.ts`
- Test (create): `apps/agent-container/tests/stage-timings.test.ts`

**Interfaces:**
- Consumes: `AgentUsageRecord`, `AgentUsageCallback`, `StageEventEmitter`.
- Produces:

```ts
// packages/agent/src/core/types.ts
export type AgentSpanKind = "model" | "tool" | "validation";

export interface AgentSpanRecord {
  kind: AgentSpanKind;
  /** Tool name, "validate_page", "mdx_compile", or the usage operation. */
  name: string;
  durationMs: number;
  ok: boolean;
  /** True when a cache or pool short-circuited real work. */
  reused?: boolean;
  context?: AgentUsageContext;
}

export type AgentSpanCallback = (span: AgentSpanRecord) => void;

// added to AgentOptions and AgentConfig
onSpan?: AgentSpanCallback;
```

```ts
// apps/agent-container/src/stage-timings.ts
export interface StageTimingSummary {
  stage: string;
  wallMs: number;
  snapshotMs: number;
  modelMs: number;
  modelCalls: number;
  toolMs: number;
  toolCalls: number;
  validationMs: number;
  validationCalls: number;
  /** wallMs minus the measured spans; container/IO/scheduling overhead. */
  unattributedMs: number;
  slowestModelCallMs: number;
  byOperation: Record<string, { calls: number; ms: number }>;
}

export function createStageTimings(stage: string): {
  onSpan: AgentSpanCallback;
  markSnapshot(durationMs: number): void;
  summarize(): StageTimingSummary;
};
```

- [ ] **Step 1: Write failing tests for span emission**

In `packages/agent/tests/tanstack-runtime.test.ts`, add a case asserting that a `run()` with a stubbed provider and one tool call emits, via `onSpan`: one `model` span per model iteration with `durationMs >= 0`, and one `tool` span named after the invoked tool. Assert `onUsage` records now carry a numeric `durationMs`.

In `packages/agent/tests/mdx-compile.test.ts`, assert `compileMdx` emits a `validation` span named `mdx_compile` when an `onSpan` option is supplied, for both the success and the `validator-crashed` paths.

In the new `apps/agent-container/tests/stage-timings.test.ts`, assert `createStageTimings("write")` aggregates injected spans into a `StageTimingSummary` whose `unattributedMs = wallMs - (modelMs + toolMs + validationMs + snapshotMs)`, clamped at `0`, and whose `byOperation` groups model spans by `context.operation`.

- [ ] **Step 2: Run the failing tests**

```bash
pnpm --filter @doxahq/agent test -- tanstack-runtime mdx-compile
pnpm --filter @doxahq/agent-container test -- stage-timings
```

Expected: FAIL — `onSpan` and `createStageTimings` do not exist.

- [ ] **Step 3: Populate model durations and emit model spans**

In `packages/agent/src/core/agent.ts`, `createDoxaUsageMiddleware` currently calls `emitUsage(...)` without `durationMs`. Record `Date.now()` at `onIteration` per iteration index, compute the delta at `onUsage`/`onFinish`, pass it as `metadata.durationMs`, and emit a matching `model` span via `options.onSpan`. Keep the existing usage semantics: never throw from the span/usage sink; wrap in the same best-effort try/catch pattern used by `emitUsage`.

- [ ] **Step 4: Emit tool spans**

In `packages/agent/src/core/tool.ts` (or the `toTanStackServerTools` wrapper in `agent.ts`, whichever owns `execute` invocation — read both before choosing), wrap each tool `execute` with a timer that emits a `tool` span with `ok` reflecting whether `execute` threw. Do not change tool output or the existing output-limiter behavior.

- [ ] **Step 5: Emit validation spans**

In `packages/agent/src/utils/mdx-compile.ts`, add an optional `onSpan` to `MdxCompileOptions` and emit a `validation` span around the subprocess call, including the crashed paths. Thread the callback from `runPageValidation` (`packages/agent/src/utils/page-validator.ts`) and from `validatePageTool`, so both the model-driven and the gate-driven validations are measured.

- [ ] **Step 6: Aggregate per stage and emit a summary event**

Create `apps/agent-container/src/stage-timings.ts`. In `apps/agent-container/src/staged-generation.ts`:
- construct `createStageTimings(input.stage)` at the top of `runGenerationStage`,
- pass `onSpan` into the `AgentConfig` built by `createAgentConfig`,
- call `markSnapshot(ms)` around `prepareWorkspace`,
- in the existing `finally`, emit `await emitEvent("stage_timing_summary", "...", summary)` **before** the `rm(workspace.stageRoot)` call.

Do not add a new stream record `kind` — reuse the event channel so `apps/agent-worker/src/workflow-stage-client.ts` needs no change.

- [ ] **Step 7: Run the tests**

```bash
pnpm --filter @doxahq/agent test -- tanstack-runtime mdx-compile
pnpm --filter @doxahq/agent-container test -- stage-timings staged-generation
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 8: Capture the baseline**

```bash
pnpm test:generation:synthetic
```

Record the `stage_timing_summary` payloads for `analysis`, `structure`, and each `write` batch into `docs/superpowers/plans/2026-07-29-generation-pipeline-performance-baseline.md` (create it) as a markdown table. This synthetic baseline is a *structural* baseline (stub provider, near-zero model latency): its value is the relative split of validation/tool/unattributed time and the call counts, not absolute milliseconds. Note explicitly in the file that model latency is stubbed.

**Acceptance criteria:**
- `AgentUsageRecord.durationMs` is populated for every hosted model call (assert in the container test that `toGenerationUsageRecord` no longer maps `null`).
- A `stage_timing_summary` event is emitted exactly once per stage request, including failed stages.
- Baseline file committed to the working tree with per-stage call counts.

**Risk / rollback:** Pure addition; if span emission regresses runtime behavior, remove the `onSpan` wiring — nothing depends on it yet.

---

### Task 2: MDX validator worker pool

**Why:** Each MDX validation spawns a `node` process that cold-imports `@mdx-js/mdx`. On a `standard-1` container (½ vCPU) with 6 concurrent writers, these spawns queue on CPU. Validation happens up to four times per page attempt.

**Files:**
- Create: `packages/agent/runtime/mdx-validator-server.mjs`
- Create: `packages/agent/src/utils/mdx-validator-pool.ts`
- Modify: `packages/agent/src/utils/mdx-compile.ts`
- Modify: `packages/agent/src/index.ts` (export `disposeMdxValidatorPool`)
- Modify: `packages/agent/scripts/preflight.mjs` and `scripts/assert-dist.mjs` (ship the new runtime file — read both first)
- Modify: `apps/agent-container/src/index.ts` (warm the pool in the existing `preflight`)
- Test: `packages/agent/tests/mdx-compile.test.ts`
- Test (create): `packages/agent/tests/mdx-validator-pool.test.ts`

**Interfaces:**

```ts
// packages/agent/src/utils/mdx-validator-pool.ts
export interface MdxValidatorPoolOptions {
  size?: number;            // default: clamp(cpus-1, 1, 4), env DOXA_MDX_VALIDATOR_POOL_SIZE wins
  requestTimeoutMs?: number; // default 10_000
  scriptPath?: string;       // test injection
  spawn?: typeof import("node:child_process").spawn; // test injection
}

export interface MdxValidatorPool {
  compile(source: string): Promise<MdxCompileResult>;
  warm(): Promise<void>;
  dispose(): Promise<void>;
  /** Test/telemetry: number of worker processes ever started. */
  readonly spawnCount: number;
}

export function createMdxValidatorPool(opts?: MdxValidatorPoolOptions): MdxValidatorPool;
export function getSharedMdxValidatorPool(): MdxValidatorPool;
export async function disposeMdxValidatorPool(): Promise<void>;
```

Wire protocol (NDJSON over stdin/stdout, one JSON object per line, no raw newlines because payloads are JSON-encoded):

```
→ {"id":"<uuid>","source":"# page\n..."}
← {"id":"<uuid>","ok":true}
← {"id":"<uuid>","ok":false,"errors":[{"rule","severity","line","col","message","snippet"}]}
```

- [ ] **Step 1: Write failing pool tests**

`packages/agent/tests/mdx-validator-pool.test.ts` with an injected fake `spawn`:
1. 20 sequential `compile()` calls with `size: 2` produce `spawnCount <= 2`.
2. Concurrent `compile()` calls are multiplexed by `id` and each resolves with its own result (interleave responses out of order in the fake to prove correlation).
3. A worker that exits mid-request → that request resolves as `validator-crashed`, and the **next** request succeeds on a respawned worker.
4. A worker that never answers → the request resolves as `validator-crashed` after `requestTimeoutMs`, the worker is killed, and `spawnCount` increments.
5. Malformed (non-JSON) worker output → `validator-crashed`, never a silent pass.
6. `dispose()` kills all workers and subsequent `compile()` calls start a fresh pool or reject deterministically (pick one, assert it).

In `packages/agent/tests/mdx-compile.test.ts`, add a real-process integration case: 5 sequential `compileMdx` calls on valid and invalid MDX return the same results as before this task (reuse the existing expectations), and the existing fail-closed cases still hold.

- [ ] **Step 2: Run the failing tests**

```bash
pnpm --filter @doxahq/agent test -- mdx-validator-pool mdx-compile
```

Expected: FAIL — pool module missing.

- [ ] **Step 3: Implement the validator server**

`packages/agent/runtime/mdx-validator-server.mjs`: read stdin line-by-line (`readline.createInterface`), `compile(source, { development: false })` per request, write one JSON line per response, never write anything else to stdout (diagnostics go to stderr). Reuse the exact error mapping (`rule`, `line`, `col`, `snippet` with `SNIPPET_RADIUS = 2`) from `packages/agent/runtime/mdx-validator.mjs` — extract the shared mapping into the new file and have the one-shot validator import it, or duplicate it deliberately and add a test that both produce identical output for the same bad input. **Do not delete `mdx-validator.mjs`** — it stays as the fallback path.

- [ ] **Step 4: Implement the pool**

`createMdxValidatorPool`: fixed-size worker array, lazy spawn, FIFO queue of pending requests, per-request timeout, `id → {resolve, timer}` map, worker `exit`/`error` handlers that reject all in-flight requests for that worker as `validator-crashed` and mark it for respawn. All failure paths return the existing `crashed()` shape. Never reject the promise — `compile()` always resolves with an `MdxCompileResult`.

- [ ] **Step 5: Route `compileMdx` through the pool**

In `packages/agent/src/utils/mdx-compile.ts`, `compileMdx` uses `getSharedMdxValidatorPool()` when the pool script resolves, and falls back to the existing one-shot `runCommand` path when the pool script cannot be located or the pool reports a hard startup failure. Keep `MdxCompileOptions.scriptPath` honored: when a caller passes `scriptPath` explicitly (tests do), bypass the pool and use the one-shot path so existing fail-closed tests stay meaningful.

`assertMdxValidatorReady` calls `pool.warm()` so the container boots with workers already hot.

- [ ] **Step 6: Ship the runtime file**

Check `packages/agent/package.json` `files` already includes `runtime` (it does). Verify `scripts/assert-dist.mjs` / `scripts/preflight.mjs` do not need to list the new file; if they enumerate runtime files, add it. Run:

```bash
pnpm --filter @doxahq/agent build
pnpm --filter @doxahq/agent preflight
```

- [ ] **Step 7: Run all validator-touching suites**

```bash
pnpm --filter @doxahq/agent test -- mdx-validator-pool mdx-compile writer-repair mdx-repair docs-quality-validator
pnpm --filter @doxahq/agent-container test
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 8: Re-measure**

```bash
pnpm test:generation:synthetic
```

Compare `validationMs` and `validationCalls` from the Task 1 baseline. Append the new numbers to the baseline file under a "After Task 2" heading.

**Acceptance criteria:**
- Validation call count unchanged; process spawn count per stage drops from ≈`validationCalls` to ≤ pool size (+ respawns).
- Every fail-closed test still passes unmodified in intent.
- Container boot still fails fast when MDX cannot compile at all.

**Risk / rollback:** A leaked worker process would hold container memory. `dispose()` is registered on `process.on("beforeExit")` and in the stage `finally`. Rollback = have `compileMdx` always take the one-shot path (single-line change).

---

### Task 3: Continuous page worker pool in the container

**Why:** `generation-service.ts:736` processes pages in fixed slices. A single slow page (3 writer attempts + repairs) idles the other 5 workers until the slice drains.

**Files:**
- Create: `packages/agent/src/utils/concurrency.ts`
- Modify: `packages/agent/src/doxa-agent/generation-service.ts`
- Test: `packages/agent/tests/generation-batches.test.ts`
- Test (create): `packages/agent/tests/concurrency.test.ts`

**Interfaces:**

```ts
// packages/agent/src/utils/concurrency.ts
export interface MapWithConcurrencyOptions {
  concurrency: number;
  abortController?: AbortController;
  /** Invoked in completion order; use for progress counters. */
  onSettled?: (index: number) => void;
}

/**
 * Runs `worker` over `items` with at most `concurrency` in flight.
 * Results are returned in INPUT order regardless of completion order.
 * Never rejects: failures are captured per item.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  options: MapWithConcurrencyOptions,
): Promise<Array<{ status: "fulfilled"; value: R } | { status: "rejected"; reason: unknown }>>;
```

- [ ] **Step 1: Write failing concurrency tests**

`packages/agent/tests/concurrency.test.ts`, using manually-resolved deferred promises (no timers, no wall-clock):
1. In-flight count never exceeds `concurrency`.
2. When item 0 stays pending, items `concurrency..n` still start as soon as *any* other item settles (this is the anti-lock-step assertion; the old slice loop fails it).
3. Results come back in input order with mixed fulfilled/rejected entries.
4. Aborting mid-run stops scheduling new items and surfaces the abort reason for unstarted items.

In `packages/agent/tests/generation-batches.test.ts`, add a test that with `concurrency: 2` and 5 pages where page 0 resolves last, the writer for page 4 has started before page 0 settles, and `result.pages` is still in structure order. Read the existing tests in that file first and preserve their intent.

- [ ] **Step 2: Run the failing tests**

```bash
pnpm --filter @doxahq/agent test -- concurrency generation-batches
```

Expected: FAIL.

- [ ] **Step 3: Implement `mapWithConcurrency`**

Simple index-cursor pool; no external dependency.

- [ ] **Step 4: Replace the slice loop**

In `generation-service.ts`, replace the `for (let i = 0; i < pagesToWrite.length; i += concurrency)` block with one `mapWithConcurrency` call over `pagesToWrite`. Preserve exactly:
- `completedCount` increments and the `onProgress` "Writing: … (n/total)" message shape,
- `checkpointWrittenPage` being awaited inside the worker (page checkpoints stream as they complete),
- **failure handling stays sequential and in input order**: after the pool drains, iterate the results in input order and call `writeFailedPageWithUserChoice` for each rejection, exactly as today, so `onPageFailure` decisions (retry/skip/abort) and `PageGenerationAbortedError` remain deterministic,
- `generatedPages` push order (input order, not completion order).

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @doxahq/agent test -- concurrency generation-batches generation docs-quality-repair public-generation-regressions
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Synthetic check**

```bash
pnpm --filter @doxahq/agent build && pnpm test:generation:synthetic
```

Expected: same page count, same navigation manifest, no ordering diff.

- [ ] **Step 7: Review checkpoint**

```bash
git diff -- packages/agent/src/doxa-agent/generation-service.ts
```

Confirm no change to failure semantics, quality-repair entry conditions, or cache-manifest persistence.

**Acceptance criteria:** No lock-step barrier remains inside a write stage; page order and failure semantics unchanged.

---

### Task 4: Concurrency-safe container stage isolation

**Why (blocking prerequisite for Task 5):** Today only one stage request per job is ever in flight, and three pieces of state silently assume that:
1. `createHostedWorkspaceLayout(base, jobId, input.stage)` keys the stage root by **stage name**, so two concurrent `write` requests share `.../stages/write`, and each one's `finally` does `rm(stageRoot, { recursive: true })` — deleting the other's artifacts mid-run.
2. `ensureRepositorySnapshot` starts with `rm(input.destination)`; two concurrent misses both wipe and re-clone the shared `.../source` directory.
3. `ActiveGenerationRequests` stores one `AbortController` per `jobId`; a second concurrent request overwrites it, so `cancel(jobId)` would abort only the newest request and `unregister` would leak the older one.

**Files:**
- Modify: `apps/agent-container/src/workspace-layout.ts`
- Modify: `apps/agent-container/src/staged-generation.ts`
- Create: `apps/agent-container/src/snapshot-lock.ts`
- Modify: `apps/agent-container/src/repository-snapshot.ts`
- Modify: `apps/agent-container/src/active-generation-requests.ts`
- Modify: `apps/agent-container/src/local-http-server.ts`
- Test: `apps/agent-container/tests/workspace-layout.test.ts`
- Test: `apps/agent-container/tests/repository-snapshot.test.ts`
- Test: `apps/agent-container/tests/active-generation-requests.test.ts`
- Test: `apps/agent-container/tests/staged-generation.test.ts`

**Interfaces:**

```ts
// workspace-layout.ts — stageId becomes a unique execution id, not the stage name
export function createHostedWorkspaceLayout(
  baseDir: string,
  workspaceId: string,
  stageId?: string,   // callers now pass `${stage}-${stageExecutionId}`
): HostedWorkspaceLayout;

// snapshot-lock.ts
/** Serializes snapshot preparation per destination within one container process. */
export function withSnapshotLock<T>(destination: string, fn: () => Promise<T>): Promise<T>;
```

- [ ] **Step 1: Write failing isolation tests**

`workspace-layout.test.ts`: two layouts built with the same `jobId` but different stage ids have **different** `stageRoot`/`artifactRoot` and the **same** `snapshotRoot`/`checkoutRoot`. Invalid stage ids still throw (keep `SAFE_WORKSPACE_ID` validation; `${stage}-${uuid}` must satisfy it — verify the regex allows `-`, it does).

`repository-snapshot.test.ts`: two concurrent `ensureRepositorySnapshot` calls with the same destination and an injected command runner produce exactly **one** clone sequence, and both resolve to the same `prepared` result.

`active-generation-requests.test.ts`: registering two controllers for the same `jobId` and calling `cancel(jobId)` aborts **both**; `unregister` of one leaves the other registered; the cancellation tombstone still aborts a request registered afterwards.

`staged-generation.test.ts`: two `runGenerationStage` write calls for the same job, interleaved via injected `prepareWorkspace`, do not delete each other's artifact roots.

- [ ] **Step 2: Run the failing tests**

```bash
pnpm --filter @doxahq/agent-container test -- workspace-layout repository-snapshot active-generation-requests staged-generation
```

Expected: FAIL.

- [ ] **Step 3: Make the stage root unique**

In `staged-generation.ts`, compute `const stageExecutionId = input.stageExecutionId ?? crypto.randomUUID()` **once** at the top of `runGenerationStage` (it is currently computed inside `createAgentConfig` — hoist it and pass it down so timings, workspace, and usage records share one id) and build the layout with `` `${input.stage}-${stageExecutionId}` ``.

- [ ] **Step 4: Serialize snapshot preparation**

Add `snapshot-lock.ts` (a `Map<string, Promise<unknown>>` chain keyed by destination). In `ensureRepositorySnapshot`, wrap the read-marker + prepare sequence in `withSnapshotLock(input.destination, ...)` so the marker check and the clone are atomic within the process.

- [ ] **Step 5: Support multiple controllers per job**

Change `ActiveGenerationRequests.controllers` to `Map<string, Set<AbortController>>`. `register` adds, `unregister` removes the specific controller (and the empty set), `cancel` aborts every controller in the set. Keep the tombstone behavior byte-identical.

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @doxahq/agent-container test
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

```bash
git diff -- apps/agent-container/src
```

Confirm the shared snapshot is still reused across stages (the marker path) and that nothing now deletes `.../source`.

**Acceptance criteria:** Two concurrent write-stage requests for one job are provably isolated on disk, share one clone, and both abort on cancel.

---

### Task 5: Parallel write-batch dispatch in the workflow

**Why:** `generation-workflow-runtime.ts` awaits each batch step before starting the next. With 60 pages at concurrency 6, that is 10 strictly sequential container round trips.

**Files:**
- Modify: `apps/agent-worker/src/generation-workflow-runtime.ts` (both batch loops: default path at `:359`, revision-aware path at `:760`)
- Modify: `packages/generation/src/generation-budget.ts`
- Modify: `apps/agent-worker/src/index.ts` (env typing)
- Test: `packages/generation/tests/generation-budget.test.ts`
- Test: `apps/agent-worker/tests/generation-workflow-runtime.test.ts`

**Interfaces:**

```ts
// packages/generation/src/generation-budget.ts
export interface WritingStageBudgetInput {
  pageCount: number;
  pageConcurrency: number;
  pageBatchTimeoutMs: number;
  /** Number of write batches dispatched in parallel. Default 1. */
  batchParallelism?: number;
}
// writingStageTimeoutMs = ceil(batchCount / batchParallelism) * pageBatchTimeoutMs
```

New env var: `DOXA_WRITE_BATCH_PARALLELISM` (default `2`, clamp `1..4`).

- [ ] **Step 1: Write failing tests**

`generation-budget.test.ts`: `writingStageTimeoutMs` divides by `batchParallelism` and rounds up; `batchParallelism` of `0`, negative, or non-integer throws via the existing assertion helpers; `assessGenerationFeasibility` uses the parallel figure.

`generation-workflow-runtime.test.ts`: with a fake `GenerationWorkflowStep` that records step start/finish order and a stub stage client, assert that with `DOXA_WRITE_BATCH_PARALLELISM=2` and 4 batches, batch 2 starts before batch 1 completes; that all page keys are collected in **batch order** regardless of completion order; that a `NonRetryableError` in one batch still fails the workflow and does not leave the others unawaited; and that `ensureJobActive` cancellation still short-circuits remaining batches. Cover **both** batch loops.

- [ ] **Step 2: Run the failing tests**

```bash
pnpm --filter @doxahq/generation test -- generation-budget
pnpm --filter @doxahq/agent-worker test -- generation-workflow-runtime
```

Expected: FAIL.

- [ ] **Step 3: Implement bounded parallel dispatch**

Replace both `for` loops with a bounded scheduler over `batches` (reuse a small local helper; do **not** import `@doxahq/agent` into the Worker bundle). Requirements:
- unique, stable `step.do` names (`write page batch ${index + 1} of ${batches.length}` — unchanged),
- `pageKeys` assembled by index, not by completion,
- `ensureWithinOverallBudget` / `ensureJobActive` still checked inside each step,
- on the first failure, awaiting the remaining in-flight steps before rethrowing (no unhandled rejections in the Workflow runtime),
- parallelism read once from env and logged in the existing `writing_started`-adjacent observability so runs are attributable.

- [ ] **Step 4: Update the feasibility budget**

Thread `batchParallelism` into `assessGenerationFeasibility` at its call site so a run is not rejected as infeasible under the old serial math.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @doxahq/generation test
pnpm --filter @doxahq/agent-worker test
pnpm typecheck
```

- [ ] **Step 6: End-to-end synthetic check**

```bash
pnpm test:generation:synthetic
```

Expected: identical published artifact set and navigation; `stage_timing_summary` shows overlapping write stages.

- [ ] **Step 7: Review checkpoint**

Confirm Task 4 landed first (`git diff -- apps/agent-container/src/workspace-layout.ts` non-empty). Parallel dispatch without Task 4 corrupts the shared checkout — do not ship them out of order.

**Acceptance criteria:** N batches complete in ≈`ceil(N / parallelism)` sequential waves; artifacts byte-identical to the serial run for the same stubbed inputs.

**Risk:** Container CPU saturation at `standard-1`. Default parallelism stays at `2` until Task 13 resolves sizing.

---

### Task 6: Stable cached prompt prefix

**Why:** `buildWriterPrompt` puts per-page fields at the top of the user message and job-wide context (project analysis, full structure, route registry, editorial brief) below it. Provider prompt caching keys on the longest common prefix, so today every page misses. The **system** prompt is already page-independent — that is the natural home for the shared blocks.

**Files:**
- Modify: `packages/agent/src/doxa-agent/prompts/dynamic/builders.ts`
- Modify: `packages/agent/src/doxa-agent/prompts/dynamic/modules.ts`
- Modify: `packages/agent/src/doxa-agent/prompts/dynamic/types.ts` (if the context needs new fields)
- Test: `packages/agent/tests/prompts.test.ts`
- Test: `packages/agent/tests/public-generation-regressions.test.ts` (only if it asserts prompt text)

**Interfaces:** no new exports. `buildWriterPrompt` returns the same `BuiltPrompt` shape; the split between `system` and `user` changes.

- [ ] **Step 1: Write failing prompt tests**

In `packages/agent/tests/prompts.test.ts`:
1. Build writer prompts for two different pages of the **same** structure/analysis/brief; assert `promptA.system === promptB.system` (byte-identical).
2. Assert the system prompt contains the shared blocks: project context summary, full documentation structure, canonical generated routes, public editorial brief, description instructions, component playbook.
3. Assert the system prompt contains **no** page-specific tokens: the page title, page description, page-type instructions, source-evidence context, writer-handoff brief, or retry hint.
4. Assert the user message still contains every page-specific block and the retry hint, and that nothing that was previously in the prompt has been dropped — compare the union of `system + user` against the current combined text for a fixture page, modulo ordering (a set-of-sections assertion, not a string equality).

- [ ] **Step 2: Run the failing tests**

```bash
pnpm --filter @doxahq/agent test -- prompts
```

Expected: FAIL.

- [ ] **Step 3: Move shared blocks into the system prompt**

Add writer-stage prompt modules (priority after `writer-quality-contract`, before the component playbook appended by `composePrompt`) that render: `PROJECT CONTEXT` (`formatAnalysisSummary`), `FULL DOCUMENTATION STRUCTURE` (`formatStructureSummary`), `CANONICAL GENERATED ROUTES` (`routeRegistryContext`), `PUBLIC EDITORIAL BRIEF` (`formatPublicEditorialBrief`), and the description instructions. Each module must return `""` when its input is absent so the generic writer prompt path is unaffected.

Trim `buildWriterPrompt`'s `userBody` to: page identity (section/page/sub-page/type), content description, page-type instructions, `RELEVANT DATA FOR THIS PAGE`, `SOURCE EVIDENCE FOR THIS PAGE`, writer-handoff context, the numbered instructions, and the retry hint.

Keep the numbered instruction list in the user message — it references page-specific evidence.

- [ ] **Step 4: Verify prefix stability at the provider boundary**

Add a test in `packages/agent/tests/tanstack-runtime.test.ts` (or extend the writer test that already stubs the provider) asserting that across two page writes in one `generateDocumentation` run, the captured `systemPrompts[0]` values are identical. This is the property that actually buys cache hits.

- [ ] **Step 5: Run the suites**

```bash
pnpm --filter @doxahq/agent test
pnpm typecheck
```

- [ ] **Step 6: Content-parity check**

```bash
pnpm --filter @doxahq/agent build && pnpm test:generation:synthetic
```

The synthetic provider keys off request content — confirm it still resolves the right page for each request (`pageForRequest` in `synthetic/runner.ts`); if it matched on the user message containing the page title, that still holds. Fix the harness if the matching heuristic breaks, but do **not** weaken it to a counter.

**Acceptance criteria:** System prompt byte-identical across all pages of a job; no prompt content lost; synthetic run unchanged.

**Note:** With `openai/gpt-5.6-luna` as the default writer model, OpenRouter caching is automatic on a stable prefix ≥ the provider's minimum. Do **not** add explicit `cache_control` breakpoints in this task — the TanStack adapter surface for per-message provider fields is unverified. If a future writer model requires explicit breakpoints, that is a follow-up with its own adapter test.

---

### Task 7: Per-job tool-result cache and repo search hardening

**Why:** Every writer re-greps the same README and re-reads the same `package.json`. `Grep` also shells out with no `--exclude-dir`, no binary skip, and **no timeout** (`runCommand` only sets a timer when `timeoutMs` is passed), so one pathological pattern can stall a page write until the stage idle deadline.

**Files:**
- Create: `packages/agent/src/core/tools/result-cache.ts`
- Modify: `packages/agent/src/core/tools/tracked.ts`
- Modify: `packages/agent/src/core/tools/index.ts`
- Modify: `packages/agent/src/core/tools/grep.ts`
- Modify: `packages/agent/src/core/tools/glob.ts`
- Modify: `packages/agent/src/doxa-agent/generation-service.ts` (create one cache per `generateDocumentation` run and pass it into `createTrackedTools`)
- Test: `packages/agent/tests/tool-policy.test.ts`
- Test (create): `packages/agent/tests/tool-result-cache.test.ts`
- Test: `packages/agent/tests/page-dependency-state.test.ts`

**Interfaces:**

```ts
// packages/agent/src/core/tools/result-cache.ts
export interface ToolResultCache {
  /** Returns cached output or runs `compute` and stores its output. */
  resolve(toolName: string, args: unknown, compute: () => Promise<string>): Promise<string>;
  readonly hits: number;
  readonly misses: number;
}

export function createToolResultCache(opts?: {
  maxEntries?: number;      // default 256
  maxEntryChars?: number;   // default 64_000 — larger outputs bypass the cache
}): ToolResultCache;

// tracked.ts
export function createTrackedTools(
  cwd: string,
  policy: AgentToolPolicy,
  options?: { resultCache?: ToolResultCache; onSpan?: AgentSpanCallback },
): TrackedTools;
```

- [ ] **Step 1: Write failing tests**

`tool-result-cache.test.ts`:
1. Two identical `Grep` invocations run `compute` once; the second returns the same string and increments `hits`.
2. Different args → different keys (assert argument-order independence via canonical JSON: `{a:1,b:2}` and `{b:2,a:1}` share a key).
3. Oversized outputs are not retained (third identical call still recomputes).
4. LRU eviction at `maxEntries`.

`page-dependency-state.test.ts`: a page whose tool calls are **all** cache hits still reports the same `sourceFilesRead`/`sourceFilesDiscovered` as an uncached run. This is the correctness trap — dependency tracking must observe cached output too.

`tool-policy.test.ts`: `Grep` args include `--exclude-dir` for `.git`, `node_modules`, `dist`, `build`, `.next`, `coverage`, plus `-I`; a `runCommand` that never resolves is aborted by the tool timeout and returns an error **string** (tools never throw); `Glob` skips the same directories.

- [ ] **Step 2: Run the failing tests**

```bash
pnpm --filter @doxahq/agent test -- tool-result-cache tool-policy page-dependency-state
```

Expected: FAIL.

- [ ] **Step 3: Implement the cache**

Key = `sha256(toolName + " " + canonicalJson(args))`. Store strings only.

- [ ] **Step 4: Wire it inside the tracked wrapper**

In `tracked.ts`, the cache lookup goes **inside** the tracking wrapper: recording (`recordFile`, `recordDiscoveredFile`, grep-output extraction) runs on the returned output whether it came from cache or from a real call. Emit a `tool` span with `reused: true` on a hit (Task 1 interface).

- [ ] **Step 5: Harden the search tools**

`grep.ts`: add the exclude-dirs and `-I`, pass `timeoutMs: 10_000` to `runCommand`, and return a clear `Error: grep timed out after 10000ms; narrow the path or pattern` string on `result.timedOut`. Keep the existing 80-line truncation. `glob.ts`: read it first; apply the same directory skips if it walks the tree itself.

- [ ] **Step 6: Scope one cache per generation run**

In `generation-service.ts`, create a single `ToolResultCache` before the write pool and pass it into every `createTrackedTools(config.cwd, "read_only", { resultCache })` call inside `writePage`. Do **not** share it across stage requests (the checkout can differ between jobs in one container).

- [ ] **Step 7: Run the suites**

```bash
pnpm --filter @doxahq/agent test
pnpm typecheck
pnpm --filter @doxahq/agent build && pnpm test:generation:synthetic
```

**Acceptance criteria:** Repeated identical tool calls within one write stage execute once; per-page dependency state is unchanged; no repo search can hang a page write.

---

### Task 8: Parallel docs-quality repair

**Why:** The repair loop picks **one** issue, regenerates **one** page, then revalidates the **entire** doc set, and repeats. With k blocking issues across distinct pages that is k serial model calls plus k full revalidations.

**Files:**
- Modify: `packages/agent/src/doxa-agent/generation-service.ts`
- Modify: `packages/agent/src/doxa-agent/docs-quality-repair.ts` (only if grouping helpers belong there)
- Test: `packages/agent/tests/docs-quality-repair.test.ts`
- Test: `packages/agent/tests/docs-quality-validator.test.ts` (regression only)

**Design (must be followed exactly — this is the part that can silently change output):**
- Per round: group blocking issues by target page, drop pages that have exhausted `maxRepairAttemptsPerPage`, and take at most `maxQualityRepairs - completedQualityRepairs` pages.
- **Candidate generation is parallel** (`mapWithConcurrency` from Task 3, bounded by `config.concurrency`).
- **Assessment and acceptance stay serial and deterministic**, iterating candidates in stable page order: for each candidate, run `validatePages(replaceGeneratedPage(currentPages, candidate))` against the *current accepted* page set, then `assessDocsQualityRepairCandidate`, then accept or record the rejection — exactly the existing logic. Cross-page issues (links) therefore still see a consistent document set.
- `completedQualityRepairs` increments once per candidate generated (unchanged accounting).
- One full `validatePages(generatedPages)` per round, after all acceptances.
- Budget-exhaustion and abort/skip behavior (`PageGenerationAbortedError`, `DocsQualityValidationError`, `skippedQualityRoutes`) is unchanged.

- [ ] **Step 1: Write failing tests**

`docs-quality-repair.test.ts`:
1. Three pages with one blocking issue each and `maxRepairAttempts: 3` → all three candidates are generated concurrently (observed in-flight ≥ 2 with an injected writer), and exactly **one** full revalidation happens for the round.
2. Acceptance order is deterministic across two runs with shuffled completion order (stub the writer to resolve in different orders; assert identical final page contents and identical `failedPages` reasons).
3. Per-page repair budget still caps a repeatedly-failing page and still raises the same exhaustion error.
4. A candidate that fixes page A but breaks a link to page B is rejected — proving assessment still runs against the accepted set.

- [ ] **Step 2: Run the failing tests**

```bash
pnpm --filter @doxahq/agent test -- docs-quality-repair
```

Expected: FAIL.

- [ ] **Step 3: Implement the round-based loop**

- [ ] **Step 4: Run the suites**

```bash
pnpm --filter @doxahq/agent test
pnpm typecheck
pnpm --filter @doxahq/agent build && pnpm test:generation:synthetic
```

**Acceptance criteria:** Same accepted/rejected decisions as the serial loop for the same inputs; revalidations drop from O(repairs) to O(rounds).

---

### Task 9: Targeted repair before full page regeneration

**Why:** `runWriterAttempts` regenerates the **whole page** (a fresh model call with the full prompt) for classes of failure that are mechanical: residual frontmatter, missing/invalid description, body-length shortfalls, fence-language issues. Targeted model repair already exists (`repairMdxWithModel`, `TARGETED_MDX_REPAIR_MAX_ATTEMPTS`) but is scoped to located MDX parser failures.

**Files:**
- Modify: `packages/agent/src/doxa-agent/writer-pipeline.ts`
- Modify: `packages/agent/src/doxa-agent/mdx-repair-model.ts` (extend issue classification only)
- Modify: `packages/agent/src/types.ts` (`WriterValidationConfig`)
- Test: `packages/agent/tests/writer-repair.test.ts`
- Test: `packages/agent/tests/writer-handoff.test.ts` (regression only if it asserts attempt counts)

**Interfaces:**

```ts
// packages/agent/src/types.ts
export interface WriterValidationConfig {
  maxAttempts: number;
  mdxCompile?: boolean;
  timeoutMs?: number;
  /** Classes eligible for targeted repair before a full regeneration. Default: ["mdx"]. */
  targetedRepairClasses?: Array<"mdx" | "frontmatter" | "description" | "length">;
}
```

- [ ] **Step 1: Write failing tests**

For each newly eligible class, assert: (a) a targeted repair is attempted first, (b) a successful repair consumes **zero** full writer attempts, (c) an unsuccessful repair falls back to the existing full regeneration path with the existing retry-hint content, (d) `ValidationHistoryEntry` still records the original issue so the retry hint is unchanged in the fallback case, (e) diagnostics (`onRepairDiagnostic`) fire with the correct class.

Also assert the default config is unchanged (`targetedRepairClasses` defaults to `["mdx"]`), so this task ships inert until the hosted profile opts in.

- [ ] **Step 2: Run the failing tests**

```bash
pnpm --filter @doxahq/agent test -- writer-repair
```

Expected: FAIL.

- [ ] **Step 3: Implement the extended classification and repair routing**

- [ ] **Step 4: Opt the hosted profile in**

In `apps/agent-container/src/generation-profile.ts`, set `HOSTED_WRITER_VALIDATION.targetedRepairClasses = ["mdx", "frontmatter", "description", "length"]`. Leave `maxAttempts: 3` for now — reducing it is a separate decision after live comparison.

- [ ] **Step 5: Run the suites**

```bash
pnpm --filter @doxahq/agent test
pnpm --filter @doxahq/agent-container test
pnpm typecheck
pnpm --filter @doxahq/agent build && pnpm test:generation:synthetic
```

**Acceptance criteria:** Mechanical failures cost one small repair call instead of one full page rewrite; fallback behavior byte-identical when repair fails.

---

### Task 10: Evidence-first single-shot writer

**Why (largest single win):** Each page runs an agentic loop with `maxSteps: 12` and read-only tools. Every tool call is a full model round trip with a growing context. The structure stage already produces `sourceEvidence` and a `writerHandoff` brief — they are advisory, not authoritative, so the model still explores.

**This task changes model behavior. It ships behind a config flag defaulting to today's behavior and is only switched on after the acceptance gate below.**

**Files:**
- Create: `packages/agent/src/doxa-agent/evidence-bundle.ts`
- Modify: `packages/agent/src/doxa-agent/writer.ts`
- Modify: `packages/agent/src/doxa-agent/generation-service.ts`
- Modify: `packages/agent/src/types.ts` (`AgentConfig.writerExploration`)
- Modify: `packages/agent/src/state/page-targets.ts` (dependency fallback)
- Modify: `apps/agent-container/src/generation-profile.ts`
- Test (create): `packages/agent/tests/evidence-bundle.test.ts`
- Test: `packages/agent/tests/generation.test.ts`
- Test: `packages/agent/tests/page-dependency-state.test.ts`

**Interfaces:**

```ts
// packages/agent/src/types.ts
export type WriterExplorationMode = "agentic" | "evidence_first";
// AgentConfig.writerExploration?: WriterExplorationMode  (default "agentic")

// packages/agent/src/doxa-agent/evidence-bundle.ts
export interface PageEvidenceBundle {
  pageId: string;
  /** Repo-relative paths actually read into the bundle. */
  paths: string[];
  /** Rendered prompt block, already char-capped. */
  context: string;
  /** True when the bundle is rich enough to skip exploration. */
  sufficient: boolean;
  reason: string;
}

export async function buildPageEvidenceBundle(input: {
  cwd: string;
  page: DocPage;
  subPage?: DocSubPage;
  analysis: ProjectAnalysis;
  handoffBrief?: WriterHandoffPageBrief;
  maxFileChars?: number;   // default 4_000 (existing MAX_EVIDENCE_FILE_CHARS)
  maxTotalChars?: number;  // default 18_000 (existing MAX_EVIDENCE_TOTAL_CHARS)
}): Promise<PageEvidenceBundle>;
```

Sufficiency rule (must be explicit and tested, not a vibe): `sufficient` is true when the bundle contains **at least one readable evidence file** *and* (the page has a `reference` with a resolved surface **or** the handoff brief supplies ≥1 `requiredTopics` entry backed by an evidence path). Otherwise `sufficient` is false and the writer falls back to the agentic loop.

- [ ] **Step 1: Write failing tests**

`evidence-bundle.test.ts` against a temp fixture repo:
1. Declared `sourceEvidence` paths are read, truncated at `maxFileChars`, and the total is capped at `maxTotalChars` with a deterministic drop order (declared order, evidence before inferred).
2. Missing/unreadable paths are skipped, not fatal, and are reported in `reason`.
3. Path containment is enforced through `resolveProjectPath` — a `../` evidence path raises `ProjectPathAccessError` (reuse the expectations in `internal-path-containment.test.ts`).
4. `sufficient` is false for a page with no evidence and no handoff brief.

`generation.test.ts`:
5. With `writerExploration: "evidence_first"` and a sufficient bundle, the stubbed provider receives exactly **one** model call for the page and the tool list passed to `run()` is empty (or `validate_page` only — pick one and assert it; recommended: keep `validate_page` available and set `maxSteps: 2`).
6. With an insufficient bundle, the writer falls back to the agentic path with `maxSteps: 12` — assert the tool list and step budget.
7. Default config (`writerExploration` unset) behaves exactly as today.

`page-dependency-state.test.ts`:
8. In evidence-first mode with no tool calls, `dependencies.sourceFilesRead` is populated from the bundle's `paths` so cache invalidation stays precise.

- [ ] **Step 2: Run the failing tests**

```bash
pnpm --filter @doxahq/agent test -- evidence-bundle generation page-dependency-state
```

Expected: FAIL.

- [ ] **Step 3: Extract and extend evidence assembly**

Move the existing `buildSourceEvidenceContext` / `evidenceForPage` logic out of `writer.ts` into `evidence-bundle.ts` unchanged in behavior, then add: handoff-brief paths, reference-surface backfill (`reference-surfaces.ts` already resolves REST/SDK surfaces — read the current working-tree version, it was modified by the concurrent agent), and the `sufficient` computation.

- [ ] **Step 4: Branch the writer**

In `writer.ts`, when `writerExploration === "evidence_first"` and `bundle.sufficient`, call `run()` with `maxSteps: 2` and only `validatePageTool` in `tools`. Otherwise keep today's `readOnlyTools(cwd) + validatePageTool` and `maxSteps: 12`. Keep `loopPolicy`, token budgets, and the whole `runWriterAttempts` retry machinery untouched.

- [ ] **Step 5: Populate dependencies without tool tracking**

In `generation-service.ts`'s `writePage`, merge `bundle.paths` into the `sourceFilesRead` passed to `createPageDependencyState` so evidence-first pages still invalidate correctly.

- [ ] **Step 6: Run the suites**

```bash
pnpm --filter @doxahq/agent test
pnpm typecheck
```

- [ ] **Step 7: Acceptance gate before flipping the hosted default**

Do **not** set `writerExploration: "evidence_first"` in `apps/agent-container/src/generation-profile.ts` until all of the following hold, and report the results to the user:
1. `pnpm test:generation:synthetic` passes in both modes.
2. A live run against one real repository in each mode produces docs where the evidence-first run has **no new** blocking `docs-quality-validator` issues and no drop in per-page word count > 20% on average. Live runs need explicit user approval (cost) — **stop and ask**.
3. Per-page model call count drops (from Task 1 timings) by ≥ 50%.

Leave the flag default at `"agentic"` and hand the decision to the user with the measurements.

**Acceptance criteria:** Evidence-first mode implemented, tested, measured, and *not* enabled by default without the gate above.

---

### Task 11: Merge analysis and structure into one plan stage

**Why:** Analysis and structure are two container requests. Each re-reads checkpoints from R2, re-parses them, rebuilds prompt context, and pays request/boot overhead — for two stages that always run back to back on the same checkout.

**Files:**
- Modify: `packages/contracts/src/index.ts` (new stage variant)
- Modify: `apps/agent-container/src/worker-core.ts` (route `/stages/plan/stream`)
- Modify: `apps/agent-container/src/staged-generation.ts`
- Modify: `apps/agent-worker/src/generation-workflow-runtime.ts`
- Modify: `apps/agent-worker/src/workflow-stage-client.ts` (pathname mapping)
- Test: `apps/agent-container/tests/staged-generation.test.ts`
- Test: `apps/agent-container/tests/worker-core.test.ts`
- Test: `apps/agent-worker/tests/generation-workflow-runtime.test.ts`

**Interfaces:**

```ts
// packages/contracts/src/index.ts
export const containerPlanStageRequestSchema = containerGenerateRequestSchema.extend({
  stage: z.literal("plan"),
  // same optional revision-aware inputs the structure stage accepts
  reusableState: reusableGenerationStateSchema.optional(),
});

// result member
{
  stage: "plan",
  analysisCheckpoint: string,
  structureCheckpoint: string,
  pageIds: string[],
  pageInputHashes: Record<string, string>,   // added here; consumed by Task 12
  navigation: RuntimeDocsNavigation,
  writerHandoff?: WriterHandoffManifest,
  snapshot?, sourceState?, analysisState?, structureState?, preliminaryPlan?, plan?, structuralFingerprint?
}
```

Keep `analysis`, `structure`, and `write` stages intact — the merge is additive, and the workflow chooses `plan` when `DOXA_PLAN_STAGE_ENABLED` is not `"0"`.

- [ ] **Step 1: Write failing tests**

`staged-generation.test.ts`: a `plan` stage request produces both checkpoints, the same `pageIds` and `navigation` as running `analysis` then `structure` sequentially (assert equality against the two-stage path with the same stubs), reuses one prepared snapshot, and emits both `analysis_complete` and `structure_created` events so the dashboard timeline is unchanged.

`worker-core.test.ts`: `/stages/plan/stream` validates and forwards; an invalid stage payload still 400s.

`generation-workflow-runtime.test.ts`: with the plan stage enabled, exactly one pre-write stage request is made; both R2 checkpoint keys (`analysis.json`, `structure.json`) are still written with the same content; the revision-aware path still stores `analysisState`/`structureState`; with `DOXA_PLAN_STAGE_ENABLED=0` the two-stage path is used unchanged.

- [ ] **Step 2: Run the failing tests**

```bash
pnpm --filter @doxahq/agent-container test -- staged-generation worker-core
pnpm --filter @doxahq/agent-worker test -- generation-workflow-runtime
```

Expected: FAIL.

- [ ] **Step 3: Implement the plan stage in the container**

Refactor `runGenerationStage` so the analysis branch and structure branch become internal functions called by both the legacy single-stage paths and the new `plan` branch. Do not duplicate logic — the incremental/reuse decisions (`analyzeIncrementalGeneration`, `finalizeIncrementalPlan`, `resolvedStructurePageBudget`, `applyGenerationProfileBudget`, `buildDeterministicNavigation`) must run exactly once and in the same order.

- [ ] **Step 4: Add `pageInputHashes` to the structure/plan result**

Export a helper from `@doxahq/agent` that computes the per-page input hash map from a structure (`buildPageInputHashMap` in `generation-service.ts` is currently module-private — export it through `doxa-agent/index.ts` and `src/index.ts`). Populate it in both the `structure` and `plan` results. Task 12 depends on this.

- [ ] **Step 5: Use the plan stage in the workflow**

Replace the two `step.do` calls with one, keeping the same two R2 writes and the same step names where possible (renaming a Workflow step changes replay identity — use a new name and accept that in-flight workflows finish on the old path; note this in the PR description).

- [ ] **Step 6: Run the suites**

```bash
pnpm --filter @doxahq/agent test
pnpm --filter @doxahq/agent-container test
pnpm --filter @doxahq/agent-worker test
pnpm --filter @doxahq/generation test
pnpm typecheck
pnpm --filter @doxahq/agent build && pnpm test:generation:synthetic
```

**Acceptance criteria:** One pre-write container round trip instead of two; identical checkpoints, navigation, page ids, and events; legacy path still selectable by env.

---

### Task 12: Content-addressed page cache in R2 (two-tier)

**Why:** The hosted write stage passes `cacheManager: undefined`, so nothing is deduplicated across runs. Note honestly what this does **not** buy: the revision-aware path (`runRevisionAwareGeneration`) already reuses unchanged pages from the baseline's published artifacts via `loadReusablePages` / `assembleIncrementalPages`, and `runResumablePageBatch` already prevents re-writing a page when a Workflow step retries. This cache covers the cases those two do not:
- a `planningFingerprint` bump or structure churn that marks every page `regenerate` while most pages' actual inputs are unchanged,
- a run whose baseline state is missing or whose `generationStatePrefix` does not match (`loadReusableState` returns `undefined` → full generation today),
- two PRs branched from the same commit regenerating the same unaffected pages,
- **a writer-model change**, via the opt-in cross-model tier below.

**Scope rule (correctness, non-negotiable):** the cache is consulted **only when a `sourceState` is available for the run** — i.e. snapshot-prepared (revision-aware / preview / doxabot) runs. The legacy default path (`createStageRequest`, `generation-workflow-runtime.ts:1555`) sends no `checkoutSpec`, so the container returns an analysis result with no `sourceState`, and no per-file digest can be computed. On that path the cache is a no-op for both reads and writes. Do not invent a fallback digest.

**Files:**
- Create: `apps/agent-worker/src/generation-page-cache.ts`
- Modify: `apps/agent-worker/src/generation-workflow-runtime.ts`
- Modify: `apps/agent-worker/src/index.ts` (env typing: `DOXA_PAGE_CACHE_ENABLED`, `DOXA_PAGE_CACHE_CROSS_MODEL`)
- Modify: `packages/contracts/src/index.ts` (export the writer contract version constants)
- Modify: `apps/api/src/services/generation-execution-config.ts` (consume those constants instead of local copies)
- Test (create): `apps/agent-worker/tests/generation-page-cache.test.ts`
- Test: `apps/agent-worker/tests/generation-workflow-runtime.test.ts`
- Test: `apps/api/tests/services/generation-execution-config.test.ts`

**Key design.** Two keys are derived per page. Both are content-addressed; they differ in exactly one field.

```ts
// packages/contracts/src/index.ts — single source of truth, no DB migration needed
export const WRITING_FINGERPRINT_VERSION = "doxabot-writing-v1";
export const WRITER_HANDOFF_CONTRACT_VERSION = "writer-handoff-v1";
/** The model-free part of writingFingerprint. */
export const WRITING_CONTRACT_VERSION =
  `${WRITING_FINGERPRINT_VERSION}:${WRITER_HANDOFF_CONTRACT_VERSION}`;
```

```ts
// apps/agent-worker/src/generation-page-cache.ts
export interface PageCacheKeyInput {
  /** Tenant scope. REQUIRED — without it two forks of one repo share cache entries. */
  siteId: string;
  pageId: string;
  /** Structure metadata hash from the plan/structure stage (Task 11). */
  pageInputHash: string;
  /** Content of the page's source dependencies at this revision. See below. */
  dependencyDigest: string;
  structuralFingerprint: string;
  documentationPolicyVersion: string;
  /**
   * Exact tier: the job's `writingFingerprint` (writer model included).
   * Cross-model tier: `WRITING_CONTRACT_VERSION` (writer model excluded).
   */
  writingContract: string;
}

export function pageCacheKey(input: PageCacheKeyInput): string; // "cache/pages/<sha256>.json"

export interface PageCacheEntry {
  page: StagedRuntimePage;
  /** Which model actually produced this content. Observability + drift attribution. */
  writerModel: string;
  writingFingerprint: string;
  createdAt: string;
}

export interface GenerationPageCache {
  getMany(keys: readonly string[]): Promise<Map<string, PageCacheEntry>>;
  putMany(entries: ReadonlyArray<{ key: string; entry: PageCacheEntry }>): Promise<void>;
}

export function createR2GenerationPageCache(bucket: R2Bucket): GenerationPageCache;

/**
 * Digest of everything on disk this page was built from, at this revision.
 * Union of: the page's declared `sourceEvidence` paths (from the structure
 * checkpoint) and, when a baseline entry exists for this pageId, its recorded
 * `dependencies.sourceFilesRead` + `dependencies.sourceEvidenceFiles`.
 * Each path is paired with its `contentHash` from `sourceState.files`;
 * a path absent from `sourceState` contributes the sentinel "absent".
 * Paths are sorted before hashing so the digest is order-independent.
 */
export function pageDependencyDigest(input: {
  paths: readonly string[];
  sourceFiles: ReadonlyMap<string, string>; // path -> contentHash, from sourceState.files
}): string;
```

**Why `writerModel` is not a separate key field:** it is already inside `writingFingerprint` (`apps/api/src/services/generation-execution-config.ts:44` joins `version:writerModel:handoffVersion`). Listing it twice would be redundant. Do not re-add it.

**Tier policy:**

| | Exact tier | Cross-model tier |
| --- | --- | --- |
| `writingContract` | job's `writingFingerprint` | `WRITING_CONTRACT_VERSION` |
| Read | whenever the cache is enabled and `sourceState` exists | only when `DOXA_PAGE_CACHE_CROSS_MODEL` is truthy **and** `context.job.publicationMode === "preview"` |
| Write | every freshly generated page | every freshly generated page (overwrite: newest model's output becomes the fallback) |
| Order | checked first | checked only for pages that missed the exact tier |

**Hard rule:** a cross-model hit must **never** be written back under the exact key. Doing so would launder the previous model's output into the current model's namespace and permanently defeat the `writingFingerprint` invalidation that `packages/agent/src/state/planning.ts:241-253` relies on. Every cross-model hit emits a `page_cache_cross_model_hit` job event carrying `pageId`, the entry's `writerModel`, and the current `writerModel`, so drift is attributable in the dashboard.

Rationale for gating cross-model reuse to previews: PR preview docs are throwaway and cost-sensitive, so mixed-model prose is an acceptable trade. Production docs must keep one consistent voice, and a writer-model upgrade must actually propagate there.

- [ ] **Step 1: Write failing tests**

`apps/api/tests/services/generation-execution-config.test.ts`:
1. `writingFingerprint` for a known writer model equals `` `${WRITING_FINGERPRINT_VERSION}:${model}:${WRITER_HANDOFF_CONTRACT_VERSION}` `` — this is the invariant that keeps the two tiers in sync; if someone changes the fingerprint format, this test must fail.

`apps/agent-worker/tests/generation-page-cache.test.ts` with an in-memory R2 fake:
2. Key is stable for identical inputs and changes when **any** field changes — assert each field individually, `siteId` included.
3. Two inputs identical except `siteId` produce different keys (tenant isolation).
4. `pageDependencyDigest` is order-independent, changes when any dependency's `contentHash` changes, and distinguishes "file missing" from "file empty".
5. Exact and cross-model keys differ for the same page, and the cross-model key is identical across two different `writerModel` values.
6. `getMany` returns only present, schema-valid entries; a corrupt or truncated entry is a miss and never throws.
7. `putMany` writes JSON with the right content type and is idempotent.

`apps/agent-worker/tests/generation-workflow-runtime.test.ts`:
8. **Stale-dependency miss (the critical one):** a page whose `pageInputHash` is unchanged but whose dependency file's `contentHash` changed does **not** hit the cache and is dispatched for regeneration.
9. A batch whose pages all hit the exact tier issues **no** container request and still contributes its page keys in batch order.
10. A partially cached batch dispatches only the missing `pageIds`; the assembled result preserves structure order.
11. Cross-model tier is **not** consulted when `DOXA_PAGE_CACHE_CROSS_MODEL` is unset, and **not** consulted for a non-preview job even when it is set.
12. With `DOXA_PAGE_CACHE_CROSS_MODEL=1` on a preview job and only a cross-model entry present, the page is served from cache, a `page_cache_cross_model_hit` event is emitted, and **no** exact-key object is written.
13. Cache writes happen only for pages generated in this run, and write both tiers.
14. A run without `sourceState` (legacy default path) performs no cache reads or writes.
15. With `DOXA_PAGE_CACHE_ENABLED=0` the behavior is exactly today's.

- [ ] **Step 2: Run the failing tests**

```bash
pnpm --filter @doxahq/api test -- generation-execution-config
pnpm --filter @doxahq/agent-worker test -- generation-page-cache generation-workflow-runtime
```

Expected: FAIL.

- [ ] **Step 3: Hoist the writer contract constants**

Add the three constants to `packages/contracts/src/index.ts` and make `apps/api/src/services/generation-execution-config.ts` import them in place of `DEFAULT_WRITING_FINGERPRINT_VERSION` / `WRITER_HANDOFF_VERSION`. The produced `writingFingerprint` string must be **byte-identical** to today's — this is a refactor, not a version bump. A changed fingerprint would invalidate every existing baseline's reuse state.

- [ ] **Step 4: Implement the cache module**

Use `stagedRuntimePageSchema` from `@doxahq/contracts` inside a `pageCacheEntrySchema` for entry validation. `pageDependencyDigest` sorts and dedupes paths before hashing.

- [ ] **Step 5: Integrate into the batch loops**

In both loops (`:359` default, `:760` revision-aware):
- resolve `sourceState` from the analysis stage result; if absent, skip the cache entirely,
- build `path -> contentHash` from `sourceState.files` once per run,
- for each page in the batch, compute `dependencyDigest` from the structure checkpoint's `sourceEvidence` plus the baseline `reusableState.pages[pageId].dependencies` when present,
- look up the exact tier; for misses, look up the cross-model tier when the gate allows,
- write hits into the existing per-batch page-checkpoint store so finalization (`assembleCheckpointedPages` / `assembleIncrementalPages`) is untouched,
- dispatch only the remaining `pageIds`,
- after a successful stage response, `putMany` both tiers for the freshly generated pages.

Cache lookups must not run before `ensureJobActive`. Cache failures (R2 error, corrupt entry) must degrade to a miss, never fail the job.

- [ ] **Step 6: Run the suites**

```bash
pnpm --filter @doxahq/api test
pnpm --filter @doxahq/agent-worker test
pnpm --filter @doxahq/generation test
pnpm typecheck
pnpm test:generation:synthetic
```

- [ ] **Step 7: APPROVAL-GATED — storage growth**

Cached pages accumulate in `DOCS_BUCKET` under `cache/pages/`, and the two-tier design stores **two** objects per generated page. **Stop and ask the user** before adding any R2 lifecycle/expiration rule; propose 30-day expiration and report the estimated object count (`2 × pages × runs`). Do not configure it unilaterally.

**Acceptance criteria:**
- A page whose source dependencies changed always misses the cache.
- Two sites never share a cache entry.
- Re-running a preview on an unchanged revision with unchanged fingerprints issues zero write-stage container requests.
- A `writingFingerprint` change invalidates the exact tier; with `DOXA_PAGE_CACHE_CROSS_MODEL=1`, preview jobs still reuse and log every cross-model hit, while production jobs regenerate.

**Risk / rollback:** `DOXA_PAGE_CACHE_ENABLED=0` disables both tiers; `DOXA_PAGE_CACHE_CROSS_MODEL` unset disables only the fallback tier. Stale content is the main hazard, and the dependency digest plus the stale-dependency test are what guard it — do not weaken either.

---

### Task 13: Container capacity and sharding decision

**Why:** `wrangler.json` pins `instance_type: "standard-1"` (½ vCPU) with `max_instances: 5`. Six concurrent page writers plus (pre-Task-2) hundreds of `node` spawns share half a core, and only five generation jobs can run platform-wide at once. Tasks 3 and 5 raise CPU pressure inside a single container.

**This task is measurement-first and APPROVAL-GATED. Do not edit `wrangler.json` without explicit user approval.**

**Files (proposal only until approved):**
- `apps/agent-container/wrangler.json`
- `apps/agent-container/src/worker.ts` (`sleepAfter`)
- `apps/agent-container/src/worker-core.ts` (optional sharding)
- Test: `apps/agent-container/tests/worker-core.test.ts`

- [ ] **Step 1: Collect evidence**

After Tasks 2, 3, and 5 are merged, run `pnpm test:generation:synthetic` and (with user approval) one live generation. From the `stage_timing_summary` events, compute per write stage: `unattributedMs / wallMs` and `validationMs / wallMs`. High unattributed time with parallel batches enabled is the CPU-starvation signal.

- [ ] **Step 2: Write the recommendation**

Append a "Capacity" section to the baseline file with: measured CPU-bound share, recommended `instance_type` (`standard-2`/`standard-3` if starved), recommended `max_instances`, and the cost delta from Cloudflare's published container pricing. Present it to the user as a decision, not a change.

- [ ] **Step 3: APPROVAL-GATED — apply the sizing**

Only after explicit approval, update `wrangler.json` for **both** the top-level and the `env.production` container blocks (they are duplicated — changing one is a silent misconfiguration). Re-run `pnpm --filter @doxahq/agent-container typecheck` and the container tests.

- [ ] **Step 4: Sharding — design only, do not implement yet**

Document (do not build) the shard option: route write batches to `getByName(`${jobId}-${shard}`)` so batches spread across container instances. Record the blocking prerequisite: each shard re-clones the repository, so sharding is only worthwhile behind a cached repository snapshot (an R2 tarball keyed by `repositoryFullName@revision`, restored instead of fetched). Note that `max_instances` must cover `jobs × shards`. Leave this as a follow-up plan item with the measurements attached.

**Acceptance criteria:** A written, measured capacity recommendation; no hosted config changed without approval.

---

## Final Verification (run after every task, and once at the end)

```bash
cd doxa-platform
git status --short
pnpm typecheck
pnpm test
pnpm --filter @doxahq/agent build
pnpm test:generation:synthetic
```

End-of-plan report to the user must include:
1. Per-stage timing table: baseline (Task 1) vs final, with call counts for model, tool, and validation spans.
2. Which flags are on by default and which are still gated (`writerExploration`, `DOXA_WRITE_BATCH_PARALLELISM`, `DOXA_PAGE_CACHE_ENABLED`, `DOXA_PAGE_CACHE_CROSS_MODEL`, `DOXA_PLAN_STAGE_ENABLED`, `targetedRepairClasses`).
3. Every APPROVAL-GATED item that is still pending a decision (Task 12 lifecycle rule, Task 13 sizing, Task 10 live comparison).
4. Anything deliberately not done, and why.

## Out of Scope

- Incremental/streaming publish of partial docs (Improvement #10) — deferred by request.
- Repository snapshot caching in R2 and container sharding — designed in Task 13, not implemented.
- Explicit provider `cache_control` breakpoints — see the note in Task 6.
- Any change to the documentation editorial contract: page budgets, structure review, navigation icons/groups, or quality rules.
