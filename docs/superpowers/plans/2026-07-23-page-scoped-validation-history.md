# Page-Scoped Validation History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pass a compact cumulative validation ledger through every retry of one page without leaking history into another page or exceeding 6,000 characters of prompt context.

**Architecture:** Store failed attempts as structured `ValidationHistoryEntry` values. Render prompt text on demand with the newest entry under `FIX NOW` and all older entries as compact `AVOID REGRESSIONS` lines. Carry the structured ledger through `PageValidationExhaustedError` into the same page's outer retry; keep the ledger local to that page execution.

**Tech Stack:** TypeScript, Vitest, existing Doxa writer pipeline and page validator.

## Global Constraints

- Writer retry feedback must not exceed 6,000 characters.
- Current issues receive prompt budget before historical references.
- Historical entries retain page-retry/attempt identity, issue rule, and location but omit raw output, debug paths, and repeated repair prose.
- Every page owns a separate history array; no mutable history is shared across concurrent pages.
- Keep the hosted five-attempt writer budget and one outer page retry unchanged.
- Preserve the workspace's existing staged changes and do not create implementation commits automatically.

---

### Task 1: Structured Ledger and Compact Renderer

**Files:**
- Modify: `packages/agent/src/utils/retry-hint.ts`
- Test: `packages/agent/tests/writer-repair.test.ts`

**Interfaces:**
- Produces: `ValidationHistoryEntry`, `buildRetryHint(history: readonly ValidationHistoryEntry[]): string`, and `RETRY_FEEDBACK_MAX_CHARS`.
- Consumes: existing `ContentQualityIssue` values and `buildFailedOutputExcerpt` behavior.

- [ ] **Step 1: Write failing renderer tests**

Add tests that construct three ledger entries and assert:

```ts
const hint = buildRetryHint([attempt1, attempt2, attempt3]);
expect(hint).toContain("FIX NOW r0.a3");
expect(hint).toContain("AVOID REGRESSIONS");
expect(hint.indexOf("r0.a1")).toBeLessThan(hint.indexOf("r0.a2"));
expect(hint).not.toContain("/tmp/debug-attempt-1.md");
expect(hint).not.toContain(attempt1.rawContent);
expect(hint.length).toBeLessThanOrEqual(RETRY_FEEDBACK_MAX_CHARS);
```

Also assert that a repeated rule remains present under every attempt where it occurred and that the newest issue retains its message, repair action, and bounded snippet.

- [ ] **Step 2: Run the renderer tests and confirm the old single-attempt API fails**

Run: `pnpm --filter @doxahq/agent test -- tests/writer-repair.test.ts`

Expected: FAIL because `ValidationHistoryEntry` and `RETRY_FEEDBACK_MAX_CHARS` do not exist and `buildRetryHint` still accepts one attempt.

- [ ] **Step 3: Implement the structured renderer**

Define:

```ts
export const RETRY_FEEDBACK_MAX_CHARS = 6_000;

export interface ValidationHistoryEntry {
  pageRetry: number;
  attempt: number;
  maxAttempts: number;
  issues: ContentQualityIssue[];
  rawContent: string;
  debugPath: string;
  finishReason?: string;
}

export function buildRetryHint(
  history: readonly ValidationHistoryEntry[],
): string;
```

Render the last entry as `FIX NOW r{pageRetry}.a{attempt}`. Render earlier entries chronologically as one line each under `AVOID REGRESSIONS`, using only issue rule and one-based location. Omit empty sections and unavailable fields. Include a current raw-output excerpt only when current issues have no useful snippets or the finish reason is `length`.

Apply the 6,000-character ceiling by truncating current messages, fix instructions, and snippets first. Preserve all attempt labels and issue rule/location pairs. Do not store rendered prompt text in the ledger.

- [ ] **Step 4: Run the renderer tests**

Run: `pnpm --filter @doxahq/agent test -- tests/writer-repair.test.ts`

Expected: PASS with compact current/history sections and no diagnostics leakage.

### Task 2: Accumulate History Across Writer Attempts

**Files:**
- Modify: `packages/agent/src/doxa-agent/writer-pipeline.ts`
- Test: `packages/agent/tests/writer-repair.test.ts`

**Interfaces:**
- Consumes: `ValidationHistoryEntry` and `buildRetryHint` from Task 1.
- Produces: `WriterAttemptOptions.initialValidationHistory`, `WriterAttemptOptions.pageRetry`, and `PageValidationExhaustedError.validationHistory`.

- [ ] **Step 1: Write failing writer-loop tests**

Add a three-attempt test whose `runOnce` captures each `retryHint`. Make attempts one and two fail with different real validator issues and attempt three succeed. Assert attempt two sees attempt one's issue as `FIX NOW`; attempt three sees attempt two as `FIX NOW` and attempt one under `AVOID REGRESSIONS`.

Add an outer-retry test:

```ts
const firstError = await captureExhaustedRun();
await runWriterAttempts({
  ...validRun,
  pageRetry: 1,
  initialValidationHistory: firstError.validationHistory,
  runOnce: async ({ retryHint }) => {
    expect(retryHint).toContain("r0.a1");
    return { text: validBody };
  },
});
```

- [ ] **Step 2: Run the writer-loop tests and confirm they fail**

Run: `pnpm --filter @doxahq/agent test -- tests/writer-repair.test.ts`

Expected: FAIL because the writer currently overwrites one retry string and the exhausted error does not expose structured history.

- [ ] **Step 3: Implement writer history accumulation**

Extend `WriterAttemptOptions` with:

```ts
initialValidationHistory?: readonly ValidationHistoryEntry[];
pageRetry?: number;
```

Clone the initial history at the start of `runWriterAttempts`. On every token-limit or validator failure, append a new entry with the current page-retry number, attempt, issues, raw output, debug path, and actionable finish reason. Rebuild `retryHint` from the complete ledger before the next provider call.

Extend `PageValidationExhaustedError` with a defensive copy:

```ts
readonly validationHistory: ValidationHistoryEntry[];
```

Ensure both the token-limit terminal path and `finalizeWithDegradation` attach the complete ledger and render the final retry hint from it.

- [ ] **Step 4: Run writer tests and package type checking**

Run: `pnpm --filter @doxahq/agent test -- tests/writer-repair.test.ts && pnpm --filter @doxahq/agent typecheck`

Expected: PASS.

### Task 3: Preserve History Across One Page's Outer Retry

**Files:**
- Modify: `packages/agent/src/doxa-agent/writer.ts`
- Modify: `packages/agent/src/doxa-agent/generation-service.ts`
- Test: `packages/agent/tests/writer-repair.test.ts`

**Interfaces:**
- Consumes: `PageValidationExhaustedError.validationHistory` from Task 2.
- Produces: page-local retry context passed through `writeDocPageTracked` into `runWriterAttempts`.

- [ ] **Step 1: Write a failing page-isolation test**

Exercise two independent writer runs with distinct initial histories and capture their first prompts. Assert page A contains only page A's rule and page B contains only page B's rule. Include outer retry label `r1` in both to prove the identity is supplied by the owning page execution rather than shared state.

- [ ] **Step 2: Run the isolation test and confirm it fails before plumbing exists**

Run: `pnpm --filter @doxahq/agent test -- tests/writer-repair.test.ts`

Expected: FAIL because writer entry points accept only a rendered `initialRetryHint` string.

- [ ] **Step 3: Pass structured context through writer entry points**

Add optional structured history and page-retry arguments to `writeDocPage` and `writeDocPageTracked`, forwarding both into `runWriterAttempts`. Retain `initialRetryHint` only for non-validation operational failures.

In `generation-service.ts`, replace the page retry's `retryFeedback` string with page-local context:

```ts
interface PageWriterRetryContext {
  initialRetryHint?: string;
  validationHistory?: readonly ValidationHistoryEntry[];
  pageRetry: number;
}
```

When the error is `PageValidationExhaustedError`, carry its structured ledger and omit the rendered string. For other errors, retain the concise operational failure hint. Keep this context as a local variable inside `writeFailedPageWithUserChoice`; never store it in generation-wide maps or arrays. Update it only from errors produced by the same `target`.

- [ ] **Step 4: Run all agent tests and type checking**

Run: `pnpm --filter @doxahq/agent test && pnpm --filter @doxahq/agent typecheck`

Expected: all agent tests pass and TypeScript reports no errors.

### Task 4: Full Verification

**Files:**
- Verify only; no production edits expected.

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: evidence that retry behavior and the existing generation/container work remain compatible.

- [ ] **Step 1: Run the full monorepo checks**

Run: `pnpm test && pnpm typecheck && pnpm build && git diff --check`

Expected: exit code 0. The existing TanStack `inputValidator()` deprecation warning may appear during the web build but is unrelated and non-fatal.

- [ ] **Step 2: Inspect the final diff**

Confirm the implementation changes only the retry renderer, writer pipeline, writer entry-point plumbing, generation-service page-local context, and their tests. Confirm the five-attempt configuration and one outer retry are unchanged.
