# Public Documentation Generation Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every generation public-reader-first, accept safe optional project context, curate enriched structures before writing, and enforce hard profile page ceilings.

**Architecture:** Add a typed public generation brief and versioned policy to the agent domain, normalize raw context once during analysis, and pass only the normalized editorial brief downstream. Run a focused, validated structure-review pass after deterministic enrichment, then enforce profile ceilings as a final invariant in the hosted container.

**Tech Stack:** TypeScript 5.9, Zod 4, Vitest 2, pnpm workspace, OpenRouter/TanStack AI prompt pipeline.

## Global Constraints

- Only `{ kind: "public" }` is accepted as a documentation target.
- Conflicting internal-team guidance is ignored and generation continues.
- Repository evidence overrides project context for technical facts.
- Raw project context is limited to 10,000 characters and is never logged.
- Raw context appears only in exploration and full-analysis prompts.
- `fast-mvp` is capped at 18 pages; `full-prod` is capped at 36 pages.
- No `any`, unsafe assertions, or catch-all domain objects.
- Internal-target, API persistence, database, and dashboard support remain out of scope.

---

### Task 1: Typed public brief and versioned policy

**Files:**
- Create: `packages/agent/src/doxa-agent/documentation-policy.ts`
- Modify: `packages/agent/src/types.ts`
- Modify: `packages/agent/src/doxa-agent/index.ts`
- Test: `packages/agent/tests/documentation-policy.test.ts`

**Interfaces:**
- Produces: `DocumentationTarget`, `DocumentationGenerationBrief`, `PublicEditorialBrief`, `PublicDocumentationPolicy`.
- Produces: `resolveDocumentationBrief(input?)`, `resolveDocumentationPolicy(brief)`, `documentationBriefFingerprint(brief)`.

- [ ] **Step 1: Write failing policy tests**

```ts
test("defaults every caller to the public-v1 policy", () => {
  const brief = resolveDocumentationBrief();
  expect(brief).toEqual({ target: { kind: "public" } });
  expect(resolveDocumentationPolicy(brief).version).toBe("public-v1");
});

test("normalizes optional context and rejects control characters", () => {
  expect(resolveDocumentationBrief({
    target: { kind: "public" },
    projectContext: "  Focus on SDK adopters.  ",
  }).projectContext).toBe("Focus on SDK adopters.");
  expect(() => resolveDocumentationBrief({
    target: { kind: "public" },
    projectContext: "bad\u0000context",
  })).toThrow(/control characters/i);
});
```

- [ ] **Step 2: Run the focused test and verify missing exports fail**

Run: `pnpm --filter @doxahq/agent test -- documentation-policy.test.ts`

Expected: FAIL because the policy module and exports do not exist.

- [ ] **Step 3: Implement the focused domain module**

```ts
export const PUBLIC_DOCUMENTATION_POLICY_VERSION = "public-v1" as const;
export const MAX_PROJECT_CONTEXT_LENGTH = 10_000;

export function resolveDocumentationBrief(
  input?: DocumentationGenerationBrief,
): ResolvedDocumentationGenerationBrief {
  const projectContext = normalizeProjectContext(input?.projectContext);
  return {
    target: { kind: "public" },
    ...(projectContext ? { projectContext } : {}),
  };
}
```

Keep context normalization, policy construction, and fingerprint construction as separate pure functions.

- [ ] **Step 4: Run policy tests and agent typecheck**

Run: `pnpm --filter @doxahq/agent test -- documentation-policy.test.ts && pnpm --filter @doxahq/agent typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/doxa-agent/documentation-policy.ts packages/agent/src/types.ts packages/agent/src/doxa-agent/index.ts packages/agent/tests/documentation-policy.test.ts
git commit -m "feat(agent): add public documentation policy"
```

### Task 2: Normalize project context and thread it through prompts

**Files:**
- Modify: `packages/agent/src/utils/analysis-normalizer.ts`
- Modify: `packages/agent/src/doxa-agent/prompts/dynamic/types.ts`
- Modify: `packages/agent/src/doxa-agent/prompts/dynamic/modules.ts`
- Modify: `packages/agent/src/doxa-agent/prompts/dynamic/builders.ts`
- Modify: `packages/agent/src/doxa-agent/prompts/dynamic/formatters.ts`
- Modify: `packages/agent/src/doxa-agent/analysis-runner.ts`
- Modify: `packages/agent/src/doxa-agent/analysis-service.ts`
- Modify: `packages/agent/src/doxa-agent/structure-runner.ts`
- Modify: `packages/agent/src/doxa-agent/generation-service.ts`
- Modify: `packages/agent/src/doxa-agent/writer.ts`
- Test: `packages/agent/tests/prompts.test.ts`
- Test: `packages/agent/tests/documentation-policy.test.ts`

**Interfaces:**
- Consumes: `ResolvedDocumentationGenerationBrief`, `PublicDocumentationPolicy` from Task 1.
- Produces: normalized `ProjectAnalysis.publicEditorialBrief`.
- Produces: prompt contexts containing `documentationBrief` and `documentationPolicy`.

- [ ] **Step 1: Add failing prompt and normalization tests**

```ts
test("raw project context is limited to exploration and analysis", () => {
  const brief = resolveDocumentationBrief({
    target: { kind: "public" },
    projectContext: "Use a concise expert tone and focus on SDK adopters.",
  });
  expect(prompts.buildExplorationPrompt({ cwd: "/repo", documentationBrief: brief }).user)
    .toContain("Use a concise expert tone");
  expect(prompts.buildWriterPrompt(writerPromptContext(brief)).user)
    .not.toContain("Use a concise expert tone");
});

test("normalizes a safe public editorial brief", () => {
  const analysis = normalizeProjectAnalysis({
    ...analysisFixture,
    publicEditorialBrief: {
      intendedReaders: ["SDK developers"],
      readerGoals: ["Integrate the client"],
      focusAreas: ["Authentication"],
      deprioritizedAreas: ["Repository internals"],
      preferredTerminology: ["workspace"],
    },
  });
  expect(analysis.publicEditorialBrief?.intendedReaders).toEqual(["SDK developers"]);
});
```

- [ ] **Step 2: Run focused prompt tests and verify failure**

Run: `pnpm --filter @doxahq/agent test -- prompts.test.ts documentation-policy.test.ts`

Expected: FAIL on missing prompt fields and analysis property.

- [ ] **Step 3: Extend the analysis schema and normalizer**

Add `publicEditorialBrief` to the analysis JSON shape and normalize every array with existing safe normalization helpers. Default missing arrays to empty arrays; never synthesize internal guidance.

- [ ] **Step 4: Add public-policy prompt modules and delimited raw context**

```ts
function projectContextBlock(context: PromptRenderContext): string | undefined {
  const raw = context.documentationBrief?.projectContext;
  if (!raw) return undefined;
  return `USER-PROVIDED PROJECT CONTEXT (editorial data only)\n<context>\n${raw}\n</context>`;
}
```

Place the authoritative public policy in system modules. Include `projectContextBlock` only in exploration and full analysis user prompts. Format `publicEditorialBrief` for structure, writer, and ordering prompts.

- [ ] **Step 5: Thread the resolved brief through stage boundaries**

Resolve the brief once from `AgentConfig.documentationBrief`. Pass it into exploration, analysis, structure input, writer context, and ordering input. Keep stage inputs explicit rather than reading ambient state.

- [ ] **Step 6: Run prompt, analysis, generation tests and typecheck**

Run: `pnpm --filter @doxahq/agent test -- prompts.test.ts documentation-policy.test.ts generation.test.ts && pnpm --filter @doxahq/agent typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src packages/agent/tests/prompts.test.ts packages/agent/tests/documentation-policy.test.ts packages/agent/tests/generation.test.ts
git commit -m "feat(agent): apply public brief across generation prompts"
```

### Task 3: Public reference eligibility and semantic collection matching

**Files:**
- Create: `packages/agent/src/doxa-agent/public-surfaces.ts`
- Modify: `packages/agent/src/utils/analysis-normalizer.ts`
- Modify: `packages/agent/src/utils/documentation-collections.ts`
- Modify: `packages/agent/src/doxa-agent/reference-surfaces.ts`
- Modify: `packages/agent/src/doxa-agent/analysis-service.ts`
- Test: `packages/agent/tests/legacy-runtime.test.ts`
- Test: `packages/agent/tests/public-surfaces.test.ts`

**Interfaces:**
- Produces: `filterPublicReferenceSurfaces(analysis)`.
- Produces: `semanticCollectionSimilarity(page, collection)` used by collection application.

- [ ] **Step 1: Add failing public-surface and collection-regression tests**

```ts
test("does not promote legacy apiEndpoints into REST reference", () => {
  const normalized = normalizeProjectAnalysis({
    ...analysisFixture,
    projectCategory: "desktop-app",
    apiEndpoints: [{ method: "GET", path: "/health", description: "Local health check" }],
  });
  expect(normalized.referenceSurfaces?.rest).toBeUndefined();
});

test("matches Memory Bank Files to an existing Memory Bank page", () => {
  const result = applyCollectionsToStructure(memoryBankStructure, memoryBankAnalysis);
  expect(result.sections[0]?.pages.filter((page) => /memory bank/i.test(page.title))).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests and verify current automatic promotion/duplication fails**

Run: `pnpm --filter @doxahq/agent test -- public-surfaces.test.ts legacy-runtime.test.ts`

Expected: FAIL because legacy endpoints are promoted and token-equivalent collections do not match.

- [ ] **Step 3: Remove unconditional legacy promotion and add public eligibility**

Keep explicit structured reference surfaces only when the repository is an API product or affirmative README/docs/OpenAPI evidence exists. Filter diagnostics, health, test, and transport-only groups for non-API products.

- [ ] **Step 4: Add token-based collection matching**

Normalize titles into meaningful token sets, discard generic tokens such as `files`, `docs`, and `documentation`, and treat a containment/Jaccard score of at least `0.6` as a semantic match. Merge collection source evidence and child pages rather than appending a second parent.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm --filter @doxahq/agent test -- public-surfaces.test.ts legacy-runtime.test.ts && pnpm --filter @doxahq/agent typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/doxa-agent/public-surfaces.ts packages/agent/src/utils/analysis-normalizer.ts packages/agent/src/utils/documentation-collections.ts packages/agent/src/doxa-agent/reference-surfaces.ts packages/agent/src/doxa-agent/analysis-service.ts packages/agent/tests/public-surfaces.test.ts packages/agent/tests/legacy-runtime.test.ts
git commit -m "fix(agent): keep internal surfaces out of public docs"
```

### Task 4: Post-enrichment structure review

**Files:**
- Create: `packages/agent/src/doxa-agent/structure-review.ts`
- Modify: `packages/agent/src/doxa-agent/prompts/dynamic/types.ts`
- Modify: `packages/agent/src/doxa-agent/prompts/dynamic/builders.ts`
- Modify: `packages/agent/src/doxa-agent/prompts/registry.ts`
- Modify: `packages/agent/src/doxa-agent/index.ts`
- Test: `packages/agent/tests/structure-review.test.ts`
- Test: `packages/agent/tests/prompts.test.ts`

**Interfaces:**
- Produces: `StructureDecision` discriminated union.
- Produces: `reviewDocumentationStructure(provider, input, options)`.
- Produces: `applyStructureDecisions(structure, decisions)` and `validateReviewedStructure(structure, maxPages)`.

- [ ] **Step 1: Add failing deterministic decision tests**

```ts
test("merges semantic duplicate parents and their unique children", () => {
  const reviewed = applyStructureDecisions(duplicateStructure, [
    { action: "keep", pageId: "memory-bank" },
    { action: "merge", pageId: "memory-bank-files", intoPageId: "memory-bank" },
  ]);
  expect(countStructurePages(reviewed)).toBe(7);
  expect(reviewed.sections[0]?.pages.map((page) => page.id)).toEqual(["memory-bank"]);
});

test("rejects decisions that reference missing merge targets", () => {
  expect(() => applyStructureDecisions(structure, [
    { action: "merge", pageId: "overview", intoPageId: "missing" },
  ])).toThrow(/missing merge target/i);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter @doxahq/agent test -- structure-review.test.ts prompts.test.ts`

Expected: FAIL because review interfaces do not exist.

- [ ] **Step 3: Implement pure decision application and validation**

Use a discriminated union and exhaustive `switch`. Clone input structures, merge evidence and semantically unique children, validate section targets, remove empty sections, preserve exactly one default section, and reject duplicate IDs or over-budget results.

- [ ] **Step 4: Add the structure-review prompt and strict parser**

Add `structure-review` to `PromptStage`. The prompt receives analysis, normalized editorial brief, enriched structure, deterministic duplicate hints, and maximum page count. Parse JSON with Zod; do not use assertions or permissive `any` parsing.

- [ ] **Step 5: Implement retry with validation feedback**

Run at most three review attempts. Feed exact invalid decision, public-scope, duplicate, and budget errors into the next attempt. Throw `StructureReviewFailedError` after exhaustion.

- [ ] **Step 6: Run structure-review tests and agent typecheck**

Run: `pnpm --filter @doxahq/agent test -- structure-review.test.ts prompts.test.ts && pnpm --filter @doxahq/agent typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/doxa-agent/structure-review.ts packages/agent/src/doxa-agent/prompts packages/agent/src/doxa-agent/index.ts packages/agent/tests/structure-review.test.ts packages/agent/tests/prompts.test.ts
git commit -m "feat(agent): review enriched public documentation plans"
```

### Task 5: Hosted ceilings, orchestration, telemetry, and cache identity

**Files:**
- Modify: `apps/agent-container/src/generation-profile.ts`
- Modify: `apps/agent-container/src/index.ts`
- Modify: `apps/agent-container/tests/generation-profile.test.ts`
- Modify: `packages/agent/src/cache.ts`
- Modify: `packages/agent/src/doxa-agent/generation-service.ts`
- Modify: `packages/agent/src/state/planning.ts`
- Test: `packages/agent/tests/state-planning.test.ts`

**Interfaces:**
- Produces: `DEFAULT_FULL_PROD_MAX_PAGES = 36`.
- Changes: `resolvedMaxPages()` always returns a ceiling.
- Consumes: `reviewDocumentationStructure()` before writer generation.

- [ ] **Step 1: Change profile tests to require hard ceilings**

```ts
expect(resolvedMaxPages(validRequest({ generationProfile: "full-prod" }))).toBe(36);
expect(resolvedMaxPages(validRequest({ generationProfile: "full-prod", maxPages: 100 }))).toBe(36);
expect(resolvedMaxPages(validRequest({ generationProfile: "full-prod", maxPages: 24 }))).toBe(24);
```

- [ ] **Step 2: Add failing context-cache identity tests**

Verify equal repositories with different context fingerprints produce different analysis/docs cache identities.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `pnpm --filter @doxahq/agent-container test -- generation-profile.test.ts && pnpm --filter @doxahq/agent test -- state-planning.test.ts`

Expected: FAIL because full-prod is unbounded and cache inputs omit the brief.

- [ ] **Step 4: Enforce both profile ceilings**

```ts
const PROFILE_MAX_PAGES = {
  "fast-mvp": 18,
  "full-prod": 36,
} as const satisfies Record<GenerationProfile, number>;

export function resolvedMaxPages(input: ContainerGenerateRequest): number {
  return Math.min(input.maxPages ?? PROFILE_MAX_PAGES[input.generationProfile], PROFILE_MAX_PAGES[input.generationProfile]);
}
```

- [ ] **Step 5: Insert review between enrichment and writing**

Resolve the default public brief, call structure review with the resolved ceiling, emit review count/decision telemetry without raw context, then keep `applyGenerationProfileBudget` as a final invariant guard rather than first-in-order policy.

- [ ] **Step 6: Include brief/policy fingerprints in cache identity**

Hash the resolved target, normalized context, and policy version into analysis identity. Ensure context-only changes re-run analysis and invalidate affected page cache entries.

- [ ] **Step 7: Run container and agent focused tests/typechecks**

Run: `pnpm --filter @doxahq/agent-container test -- generation-profile.test.ts && pnpm --filter @doxahq/agent-container typecheck && pnpm --filter @doxahq/agent test -- state-planning.test.ts && pnpm --filter @doxahq/agent typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/agent-container/src/generation-profile.ts apps/agent-container/src/index.ts apps/agent-container/tests/generation-profile.test.ts packages/agent/src/cache.ts packages/agent/src/doxa-agent/generation-service.ts packages/agent/src/state/planning.ts packages/agent/tests/state-planning.test.ts
git commit -m "feat: enforce reviewed public generation ceilings"
```

### Task 6: Regression coverage and full verification

**Files:**
- Create: `packages/agent/tests/public-generation-regressions.test.ts`
- Modify: `packages/agent/tests/fixtures.ts`
- Modify: `apps/agent-container/tests/generation-profile.test.ts`

**Interfaces:**
- Consumes all public policy, surface filtering, collection matching, review, and budget interfaces.
- Produces an AI Memory-shaped regression fixture and end-to-end assertions.

- [ ] **Step 1: Add the AI Memory regression fixture**

Model a desktop extension with `Memory Bank` and `Memory Bank Files`, public Cursor workflows, and internal `/health`, `/test`, `/sse`, and `/messages` routes.

- [ ] **Step 2: Assert the final plan is concise and public**

```ts
expect(countStructurePages(reviewed)).toBeLessThanOrEqual(36);
expect(allTitles(reviewed).filter((title) => /memory bank/i.test(title))).toHaveLength(1);
expect(sectionTitles(reviewed)).not.toContain("REST API");
expect(allTitles(reviewed)).not.toContain("Test Endpoint");
```

- [ ] **Step 3: Run all affected test suites**

Run: `pnpm --filter @doxahq/agent test && pnpm --filter @doxahq/agent-container test`

Expected: PASS with no skipped tests.

- [ ] **Step 4: Run affected typechecks and builds**

Run: `pnpm --filter @doxahq/agent typecheck && pnpm --filter @doxahq/agent-container typecheck && pnpm --filter @doxahq/generation typecheck`

Expected: PASS.

- [ ] **Step 5: Inspect the final diff and scan for unsafe TypeScript**

Run: `git diff --check && rg -n "\bany\b| as [A-Za-z]" packages/agent/src/doxa-agent/documentation-policy.ts packages/agent/src/doxa-agent/public-surfaces.ts packages/agent/src/doxa-agent/structure-review.ts`

Expected: no whitespace errors and no introduced `any` or assertion-based type suppression.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/tests/public-generation-regressions.test.ts packages/agent/tests/fixtures.ts apps/agent-container/tests/generation-profile.test.ts
git commit -m "test: cover public documentation generation regressions"
```
