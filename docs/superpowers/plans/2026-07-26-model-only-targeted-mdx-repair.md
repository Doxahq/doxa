# Model-Only Targeted MDX Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace deterministic MDX mutation with three bounded writer-model patch attempts against one immutable draft, then preserve the existing single outer page retry.

**Architecture:** `mdx-repair-model.ts` owns the targeted three-attempt model loop and returns structured attempt results. The writer pipeline classifies eligible located parser failures, delegates the immutable draft once, emits per-attempt diagnostics, and throws an exhaustion error reporting the repair budget. Patch utilities only validate coordinates, hashes, and bounds; the generation service retains its existing one-time fresh-page retry.

**Tech Stack:** TypeScript, Zod 4, Vitest, MDX page validation, OpenRouter-backed `Provider`, pnpm workspace

## Global Constraints

- Never mutate generated MDX with deterministic content-repair rules.
- A located parser failure receives exactly three model patch opportunities per page run.
- Every patch in one repair cycle targets the same immutable draft and SHA-256.
- Targeted repair must never invoke the full page writer.
- Revalidate the complete patched page after every accepted patch.
- The existing single outer page retry generates one fresh draft after repair exhaustion.
- Non-parser, multi-issue, and unlocated failures retain the existing full writer retry behavior.
- Preserve failed-draft diagnostics and model-usage telemetry; do not add customer dashboard UI.
- Do not commit implementation changes until the user reviews the completed result.

---

### Task 1: Model-only immutable-draft repair engine

**Files:**
- Modify: `packages/agent/src/utils/mdx-repair.ts`
- Modify: `packages/agent/src/doxa-agent/mdx-repair-model.ts`
- Modify: `packages/agent/src/doxa-agent/index.ts`
- Modify: `packages/agent/src/index.ts`
- Test: `packages/agent/tests/mdx-repair.test.ts`

**Interfaces:**
- Consumes: `Provider`, `AgentUsageCallback`, `MdxRepairPatch`, `LocatedMdxIssue`, `validateMdxRepairPatch()`, and `applyMdxRepairPatch()`.
- Produces:

```ts
export interface MdxRepairAttemptResult {
  attempt: number;
  accepted: boolean;
  rejectionReason: string | null;
  validationIssueCodes: string[];
}

export type ModelMdxRepairResult =
  | {
      ok: true;
      content: string;
      attempts: MdxRepairAttemptResult[];
    }
  | {
      ok: false;
      content: null;
      attempts: MdxRepairAttemptResult[];
    };

export async function repairMdxWithModel(
  input: RequestMdxRepairPatchInput & {
    maxAttempts: number;
    validate: (
      content: string,
    ) => Promise<{ ok: boolean; issueCodes: string[] }>;
  },
): Promise<ModelMdxRepairResult>;
```

- [x] **Step 1: Replace deterministic-repair tests with failing immutable model-loop tests**

Remove imports and assertions for `repairMdxDeterministically()`. Add injected model-call coverage proving:

```ts
expect(modelDraftHashes).toEqual([
  sha256(originalDraft),
  sha256(originalDraft),
  sha256(originalDraft),
]);
expect(result.attempts).toHaveLength(3);
expect(result.ok).toBe(false);
```

Add separate tests where patch attempts 1, 2, and 3 produce the first completely valid page. Assert malformed JSON, stale hashes, distant patches, oversized patches, and still-invalid patched pages consume one attempt and send their rejection reason into the next prompt.

- [x] **Step 2: Run the focused tests and confirm the old API cannot satisfy them**

Run:

```bash
pnpm --filter @doxahq/agent test -- mdx-repair
```

Expected: FAIL because `repairMdxWithModel()` and structured attempt results do not exist and deterministic-repair exports remain.

- [x] **Step 3: Remove deterministic content mutation**

Delete `DeterministicMdxRepairInput`, `MdxRepairResult`,
`repairMdxDeterministically()`, `deterministicCandidates()`,
`isProtectedMdxOffset()`, `isFrontmatterLine()`, `isInsideFence()`,
`isInsideInlineCode()`, and `looksLikeValidJsx()` from
`packages/agent/src/utils/mdx-repair.ts`. Retain only offset conversion, hashing,
patch validation, and patch application.

- [x] **Step 4: Implement the three-attempt model repair service**

Refactor `requestMdxRepairPatch()` into a single-call internal helper returning
either a validated patch or an exact rejection reason. Implement
`repairMdxWithModel()` with one immutable draft:

```ts
const originalDraft = input.draft;
const attempts: MdxRepairAttemptResult[] = [];
let previousRejection = "";

for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
  const patchResult = await requestPatchOnce({
    ...input,
    draft: originalDraft,
    attempt,
    previousRejection,
  });
  if (!patchResult.ok) {
    previousRejection = patchResult.reason;
    attempts.push({
      attempt,
      accepted: false,
      rejectionReason: previousRejection,
      validationIssueCodes: [],
    });
    continue;
  }

  const content = applyMdxRepairPatch(originalDraft, patchResult.patch);
  const validation = await input.validate(content);
  if (validation.ok) {
    attempts.push({
      attempt,
      accepted: true,
      rejectionReason: null,
      validationIssueCodes: [],
    });
    return { ok: true, content, attempts };
  }

  previousRejection =
    `patched-page-validation-failed:${validation.issueCodes.join(",")}`;
  attempts.push({
    attempt,
    accepted: false,
    rejectionReason: previousRejection,
    validationIssueCodes: validation.issueCodes,
  });
}

return { ok: false, content: null, attempts };
```

The prompt must include `Targeted repair attempt X/3`, the immutable draft hash,
the exact parser line/column/offset, the absolute source-window range, and the
previous rejection reason.

- [x] **Step 5: Run the model-repair tests**

Run:

```bash
pnpm --filter @doxahq/agent test -- mdx-repair
```

Expected: PASS, with no deterministic repair export remaining.

- [x] **Step 6: Review checkpoint**

Inspect:

```bash
git diff -- packages/agent/src/utils/mdx-repair.ts packages/agent/src/doxa-agent/mdx-repair-model.ts packages/agent/tests/mdx-repair.test.ts
```

Confirm all content-changing decisions come from the writer model and every
attempt uses the original draft.

---

### Task 2: Writer pipeline and retry semantics

**Files:**
- Modify: `packages/agent/src/types.ts`
- Modify: `packages/agent/src/doxa-agent/writer.ts`
- Modify: `packages/agent/src/doxa-agent/writer-pipeline.ts`
- Test: `packages/agent/tests/writer-repair.test.ts`
- Test: `packages/agent/tests/generation-batches.test.ts`

**Interfaces:**
- Consumes: `repairMdxWithModel()` and `ModelMdxRepairResult` from Task 1.
- Produces:

```ts
export interface WriterRepairAttemptDiagnostic {
  pageId: string;
  pageTitle: string;
  pageRetry: number;
  writerAttempt: number;
  repairAttempt: number;
  maxRepairAttempts: number;
  rule: string;
  message: string;
  line?: number;
  column?: number;
  snippet?: string;
  draft: string;
  repairKind: "model_patch";
  repairSucceeded: boolean;
  rejectionReason?: string;
  validationIssueCodes: string[];
}
```

- [x] **Step 1: Write failing writer-pipeline tests**

Replace the current deterministic success and two-patch early-exit tests with:

```ts
expect(writerCalls).toBe(1);
expect(repairCalls).toBe(3);
expect(exhausted.attempts).toBe(3);
expect(repairDrafts).toEqual([originalDraft, originalDraft, originalDraft]);
```

Add successful repair cases for each repair attempt and assert the complete
patched page is returned without a second writer call. Add a non-local
validation test proving `runOnce()` still executes up to the configured writer
attempt limit.

- [x] **Step 2: Add failing outer-retry regression tests**

Exercise the generation-service page failure callback with
`pageFailureMaxRetries: 1`:

```ts
expect(fullPageWriterCalls).toBe(2);
expect(targetedRepairCalls).toBe(6);
expect(abortedFailure.reason).toContain(
  "failed targeted MDX repair after 3 attempts",
);
```

Add a recovery case where the first three-patch cycle exhausts and the fresh
outer-retry draft is repaired successfully. Assert no third full page is
generated.

- [x] **Step 3: Run focused tests and verify the early-exit behavior fails them**

Run:

```bash
pnpm --filter @doxahq/agent test -- writer-repair generation-batches
```

Expected: FAIL because the current local parser branch throws after one writer
attempt and reports `attempts: 1`.

- [x] **Step 4: Replace the writer callback with one repair-cycle call**

Change `WriterAttemptOptions.repairMdx` to accept the immutable draft and located
issue once and return `ModelMdxRepairResult`. In both tracked and untracked
writers, call:

```ts
repairMdxWithModel({
  provider,
  draft,
  issue,
  pageId,
  pageTitle: title,
  pageRetry,
  writerAttempt,
  maxAttempts: writerValidation.maxAttempts,
  abortController,
  onUsage,
  validate: async (content) => {
    const report = await runPageValidation(content, {
      mdxCompile: writerValidation.mdxCompile,
      timeoutMs: writerValidation.timeoutMs,
      cwd,
    });
    return {
      ok: report.ok && report.issues.length === 0,
      issueCodes: report.issues.map((entry) => entry.rule),
    };
  },
});
```

- [x] **Step 5: Remove the local deterministic/early-throw helper**

Delete the deterministic branch from `repairLocalMdxFailure()`. Delegate once to
the model repair service. Emit one diagnostic for every returned attempt. On
exhaustion, save the immutable failed draft and throw:

```ts
throw new PageValidationExhaustedError({
  title: opts.title,
  attempts: repairResult.attempts.length,
  issues: allIssues,
  failedContent: validationPage,
  validationHistory,
});
```

The general writer loop remains unchanged for failures that are not a single
hard issue with a reliable line and column.

- [x] **Step 6: Run writer and generation retry tests**

Run:

```bash
pnpm --filter @doxahq/agent test -- writer-repair generation-batches
```

Expected: PASS. Located failures use three patches per page run; the outer
retry generates at most one fresh page.

- [x] **Step 7: Review checkpoint**

Inspect:

```bash
git diff -- packages/agent/src/doxa-agent/writer.ts packages/agent/src/doxa-agent/writer-pipeline.ts packages/agent/tests/writer-repair.test.ts packages/agent/tests/generation-batches.test.ts
```

Confirm repair attempt counts are not conflated with full writer calls or outer
page retry counts.

---

### Task 3: Per-attempt repair diagnostics and regression verification

**Files:**
- Modify: `packages/contracts/src/generation-observability.ts`
- Modify: `apps/agent-container/src/staged-generation.ts`
- Modify: `apps/agent-container/tests/staged-generation.test.ts`
- Modify: `apps/agent-worker/tests/generation-observability.test.ts`
- Modify: `apps/agent-worker/tests/workflow-stage-client.test.ts`
- Modify: `packages/generation/tests/generation-observability-contracts.test.ts`
- Modify: `docs/generation-observability.md`

**Interfaces:**
- Consumes: `WriterRepairAttemptDiagnostic` from Task 2.
- Produces a `GenerationRepairDiagnostic` where `attempt` is the targeted repair
  attempt, `maxAttempts` is three, and rejection details remain internal.

- [x] **Step 1: Write failing diagnostic contract tests**

Update fixtures to contain:

```ts
{
  attempt: 2,
  maxAttempts: 3,
  writerAttempt: 1,
  repairKind: "model_patch",
  repairSucceeded: false,
  rejectionReason: "patch-does-not-overlap-parser-location",
  validationIssueCodes: [],
}
```

Assert the contract rejects `repairKind: "deterministic"`, attempt zero,
`attempt > maxAttempts`, and unbounded rejection text.

- [x] **Step 2: Run focused observability tests**

Run:

```bash
pnpm --filter @doxahq/generation test -- generation-observability-contracts
pnpm --filter @doxahq/agent-container test -- staged-generation
pnpm --filter @doxahq/agent-worker test -- generation-observability workflow-stage-client
```

Expected: FAIL until the per-attempt contract is implemented.

- [x] **Step 3: Implement bounded per-attempt diagnostics**

Extend the internal repair diagnostic contract with:

```ts
writerAttempt: z.number().int().positive(),
attempt: z.number().int().positive(),
maxAttempts: z.number().int().positive(),
rejectionReason: z.string().max(2_000).nullable(),
validationIssueCodes: z.array(z.string().trim().min(1)).max(20),
repairKind: z.literal("model_patch"),
repairSucceeded: z.boolean(),
```

Add a schema refinement requiring `attempt <= maxAttempts`. Map these fields in
`toGenerationRepairDiagnostic()` and continue truncating the stored draft and
snippet. Do not add dashboard rendering.

- [x] **Step 4: Update internal observability documentation**

Document that:

- usage events with `operation=mdx_repair` identify every model call;
- repair diagnostics identify page retry, writer attempt, targeted repair
  attempt, rejection reason, and final validation result;
- full failed drafts remain limited-retention internal records;
- no repair telemetry appears in customer-facing dashboard UI.

- [x] **Step 5: Run focused observability tests**

Run:

```bash
pnpm --filter @doxahq/generation test -- generation-observability-contracts
pnpm --filter @doxahq/agent-container test -- staged-generation
pnpm --filter @doxahq/agent-worker test -- generation-observability workflow-stage-client
```

Expected: PASS.

- [x] **Step 6: Run full verification**

Run:

```bash
pnpm --filter @doxahq/agent test
pnpm --filter @doxahq/agent-container test
pnpm --filter @doxahq/agent-worker test
pnpm --filter @doxahq/generation test
pnpm typecheck
pnpm build
git diff --check
```

Expected: all commands succeed. Review terminal diagnostics to confirm three
targeted model attempts are distinguishable from the single outer page retry.

- [x] **Step 7: Final user review checkpoint**

Do not commit implementation files. Summarize behavior, tests, and remaining
unrelated worktree changes so the user can review and explicitly request the
commit.
