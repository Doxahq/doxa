# Public Documentation Target and Project Context Design

**Date:** 2026-07-20

## Summary

Doxa will generate public-facing documentation only. The agent will infer the most useful public reader from the product surface—SDK adopter, API consumer, tool user, application operator, or similar—and optimize the documentation for that reader's successful use of the product.

Generation may also receive optional project-wide context. That context can guide positioning, terminology, tone, reader emphasis, and topic priority, but it cannot change the public target, override repository evidence, expose internal material, or weaken generation safeguards. Conflicting guidance is ignored and generation continues under the public policy.

The implementation will keep the target represented as a discriminated type so a future internal-documentation target can be added without redesigning the pipeline. Internal generation is explicitly out of scope for this change.

## Goals

- Make public documentation an explicit, deterministic generation policy rather than a prompt convention.
- Infer the appropriate public reader and workflows from the type of product being documented.
- Accept optional free-form project context as editorial guidance.
- Prevent project context from changing the public target or introducing private/internal documentation.
- Apply the same resolved target and editorial guidance to exploration, analysis, structure, structure review, writing, and navigation ordering.
- Give every generation profile a hard page ceiling.
- Review the complete enriched structure before page writing, with semantic merge, move, keep, and drop decisions.
- Make caches and telemetry aware of target, context, and policy changes.
- Preserve an extension point for a future internal target without exposing or implementing it now.

## Non-goals

- No internal-team documentation mode.
- No target selector in the API, database, dashboard, or frontend.
- No project-context database field or dashboard editor in this phase.
- No attempt to let project context override factual source evidence.
- No unbounded generation profile.
- No one-page-per-endpoint or one-page-per-export guarantee when grouping produces better public documentation.

## Current Problems

The existing prompts generally prefer consumer/adopter documentation, but the rule is not authoritative. `ProjectAnalysis.documentationIntent.audience` still permits consumer, maintainer, or mixed output, page metadata can select maintainer content, and some legacy templates interpret `answers.audience` and `answers.context` independently.

The hosted container passes an empty `answers` object. Reusing `answers.context` would therefore be untyped and would not reliably reach exploration, analysis, structure, writing, caching, or hosted generation.

The current page budget applies only to `fast-mvp`; `full-prod` is unbounded. Deterministic collection and reference insertion happens before budgeting and can create semantic duplicates. Validation checks exact titles and required coverage, but it does not judge whole-plan usefulness, semantic overlap, public relevance, or product importance.

## Domain Model

The agent package will own the generation-domain types:

```ts
export type DocumentationTarget =
  | { kind: "public" };

export interface DocumentationGenerationBrief {
  target: DocumentationTarget;
  projectContext?: string;
}

export interface PublicEditorialBrief {
  productPositioning?: string;
  intendedReaders: string[];
  readerGoals: string[];
  focusAreas: string[];
  deprioritizedAreas: string[];
  preferredTone?: string;
  preferredTerminology: string[];
}
```

`DocumentationTarget` intentionally uses a discriminated object rather than a boolean or a broad audience string. A future change may add another union member, but this implementation and its runtime schemas accept only `{ kind: "public" }`.

`DocumentationGenerationBrief` is immutable task-wide input. The default brief is public with no project context, so existing callers preserve public behavior without supplying a value.

`PublicEditorialBrief` is normalized analysis output. Raw project context is not passed directly into downstream structure and writer prompts.

## Public Documentation Policy

A deterministic `resolveDocumentationPolicy()` function will map the brief to a versioned policy object. The initial policy is `public-v1` and establishes the following precedence:

1. Public documentation policy.
2. Verified repository evidence.
3. Normalized project context.
4. Model inference for unresolved editorial choices.

The public policy requires the agent to:

- Infer the primary public reader from the product rather than treating every repository as a generic developer project.
- Prioritize orientation, installation, first success, primary workflows, configuration, troubleshooting, and verified public references.
- Treat SDK exports as public only when they are published/exported product interfaces.
- Treat HTTP/RPC routes as public only when repository evidence presents them as an externally supported API.
- Exclude localhost health checks, diagnostics, tests, private transports, repository scripts, private exports, and internal implementation paths from public reference surfaces.
- Put verified REST and SDK reference surfaces in separate sections.
- Permit a Development section only for genuinely public contributor material supported by public README/contribution evidence. It must remain secondary to adopter documentation.
- Ignore project-context instructions that request internal-team, confidential, repository-maintainer, or otherwise non-public documentation.

Page-level `consumer`, `reference`, and `maintainer` metadata remains a content classification mechanism, not the generation target. Under `public-v1`, maintainer pages are valid only inside a justified public Development section.

## Project Context Handling

Project context is optional free-form text. The agent boundary will normalize whitespace, reject control characters, and enforce a maximum of 10,000 characters. Empty normalized text becomes absent.

Raw context is used only during exploration and full analysis:

- The public policy remains in the system prompt.
- Raw context is placed in a clearly delimited user-data block.
- The prompt explicitly identifies it as editorial input, not executable instructions or technical evidence.
- Conflicting internal guidance is ignored without failing generation.

The existing analysis response gains a `publicEditorialBrief` field. Analysis extracts only allowed editorial guidance such as public reader description, positioning, reader goals, focus areas, terminology, and tone. Unsupported technical claims remain user-provided claims and cannot override source evidence. Internal-target instructions are omitted from the normalized brief.

After analysis, structure, review, writing, and ordering receive the normalized editorial brief rather than the raw text. This keeps downstream prompts concise and prevents conflicting raw instructions from being repeated across dozens of model calls.

## Pipeline Integration

The generation brief and resolved policy must reach every relevant stage:

1. **Exploration:** prioritize product-facing files and workflows using the public policy and optional raw context.
2. **Analysis:** infer the public product profile, public interfaces, canonical workflows, internal-only evidence, and normalized editorial brief.
3. **Deterministic enrichment:** add only verified public collections and reference surfaces.
4. **Structure proposal:** generate a reader-first public structure using the normalized editorial brief and profile budget.
5. **Post-enrichment review:** review the fully enriched structure before any pages are written.
6. **Writing:** apply public policy, page purpose, verified evidence, canonical workflows, and normalized tone/terminology.
7. **Ordering:** group and order pages around the intended public reader's progression.
8. **Whole-doc validation:** verify public-scope rules, coverage, links, semantic uniqueness, and budget before publication.

The task-wide brief should be exposed on `AgentConfig` for orchestration and included explicitly in stage inputs that are cached or invoked independently. `PromptRenderContext` will carry the resolved policy and normalized editorial brief, avoiding ad hoc access through `answers`.

The hosted container will construct the default public brief. Agent-level callers and tests may supply optional project context immediately. A later platform phase can add an optional `projectContext` field to the generation request and persist it without changing the agent-domain model.

## Page Budgets

Initial hard ceilings are:

- `fast-mvp`: 18 total generated pages.
- `full-prod`: 36 total generated pages.

An explicit lower caller limit may reduce the resolved ceiling, but callers cannot raise it above the profile ceiling. `full-prod` means deeper analysis, plan review, writing, and validation; it does not mean unbounded output.

Budgeting occurs after deterministic enrichment and semantic review input construction. The current first-in-order truncation will not be used as the primary policy because it can remove later reference sections and preserve lower-value earlier pages.

Reference completeness is measured by documented coverage, not by one generated page per endpoint/export. Related endpoints may be grouped by resource and related exports by module when needed to fit the public plan cleanly.

## Post-enrichment Structure Review

The review combines deterministic checks with one focused model review.

Deterministic preparation identifies:

- Exact and normalized title/slug duplicates.
- Repeated source evidence.
- Duplicate collection items.
- Internal-only routes and paths.
- Unverified reference surfaces.
- Section/audience conflicts.
- Current and maximum page counts.

The review returns explicit decisions:

```ts
type StructureDecision =
  | { action: "keep"; pageId: string }
  | { action: "merge"; pageId: string; intoPageId: string }
  | { action: "move"; pageId: string; sectionId: string }
  | { action: "drop"; pageId: string; reason: string };
```

Pages are judged on public-reader relevance, primary-workflow importance, evidence strength, uniqueness, project-context priority, correct section, and ability to sustain a useful standalone page.

Applying review decisions must be deterministic and validated. Merge targets and move targets must exist, every retained page ID must be unique, required onboarding coverage must remain, and the final count must satisfy the hard ceiling.

If review output is invalid or remains over budget, the review receives precise validation feedback and retries up to three total attempts. Exhaustion fails structure planning before page writing with a user-safe message. It must not silently publish an arbitrary truncation.

## Reference and Collection Rules

Legacy `apiEndpoints` must no longer automatically imply a public REST reference surface. Promotion requires public-interface evidence such as README usage, published API documentation, a public route prefix/schema, or explicit public product positioning.

Documentation collections remain eligible only when they represent repeated public product surfaces. Semantic matching must compare normalized IDs, titles, item titles, and source-evidence overlap so equivalent collections such as `Memory Bank` and `Memory Bank Files` merge rather than duplicate.

Structure validation must inspect both parent and child pages. Exact title checks alone are insufficient.

## Caching

Analysis cache identity must include:

- Documentation target.
- Hash of normalized raw project context.
- Public policy version.

Changing context with an unchanged Git commit must trigger reanalysis. Generated-page cache identity must include the normalized editorial brief and policy version, either through the analysis hash or an explicit generation-brief hash.

Raw context must never be stored in debug manifests or cache metadata unless it is already part of an explicitly persisted platform record in the later platform phase.

## Telemetry and Errors

Generation events may include:

- `documentationTarget: "public"`
- `documentationPolicyVersion: "public-v1"`
- `projectContextProvided: boolean`
- Normalized context length.
- Context hash.
- Original, reviewed, and final page counts.
- Counts of keep, merge, move, and drop decisions.

Events and errors must not contain raw project context.

Invalid target values fail request validation. Conflicting internal guidance does not fail generation and is not propagated downstream. Invalid review output retries with precise feedback; exhausted review attempts produce a public, non-technical planning error.

## Testing Strategy

### Unit tests

- Default brief resolves to `public-v1`.
- Only the public target is accepted.
- Context normalization enforces length and control-character rules.
- Public policy takes precedence over conflicting context.
- Full-prod resolves to 36 pages and fast-mvp to 18.
- Caller limits can lower but not raise profile ceilings.
- Structure decisions apply deterministically and reject invalid references.
- Semantic collection matching merges equivalent collections.
- Legacy/internal endpoints do not automatically become public REST surfaces.
- Cache fingerprints change when target, policy version, or context changes.

### Prompt tests

- Public policy appears in every relevant stage.
- Raw context appears only in exploration and full analysis.
- Structure, writer, and ordering prompts receive normalized editorial guidance.
- Context requesting internal documentation cannot change the target or downstream brief.
- No-context prompts remain concise and public by default.

### Fixture and integration tests

- SDK fixture: adopter guides plus grouped public API reference.
- API-service fixture: public endpoints documented; health/test/internal routes excluded.
- CLI/tool fixture: installation and workflows prioritized over source internals.
- Application fixture: user/operator workflows inferred correctly.
- AI Memory regression fixture: duplicate Memory Bank collections merge, internal MCP transport routes are excluded from public REST reference, and output remains within budget.
- End-to-end generation request preserves public defaults when no platform context exists.

## Implementation Phases

### Phase 1: Agent and container behavior

- Add domain types, normalization, policy resolution, and prompt context.
- Add normalized editorial guidance to analysis.
- Thread the brief through every agent stage.
- Implement post-enrichment review and deterministic decision application.
- Enforce profile ceilings after review.
- Tighten public reference/collection eligibility and validation.
- Update cache fingerprints, telemetry, and tests.

### Phase 2: Platform wiring — later, not part of this implementation

- Persist optional project context.
- Add API request/response fields.
- Add dashboard editing and generation configuration UI.
- Pass persisted context into the existing agent brief.

## Acceptance Criteria

- Every generation uses `public-v1`; no current input can select internal documentation.
- With no context, existing callers generate public docs using inferred product readers.
- Optional context consistently affects allowed editorial choices across the pipeline.
- Internal/conflicting context has no downstream effect and does not stop generation.
- Full-prod never exceeds 36 pages and fast-mvp never exceeds 18 pages.
- The final structure is reviewed after enrichment and before writing.
- Semantic duplicate collections/pages are merged or dropped.
- Internal routes and private implementation surfaces do not become public references without affirmative public evidence.
- Context changes invalidate relevant caches.
- Raw context does not appear in logs or errors.
- AI Memory regression coverage demonstrates a concise, public, non-duplicative plan.
