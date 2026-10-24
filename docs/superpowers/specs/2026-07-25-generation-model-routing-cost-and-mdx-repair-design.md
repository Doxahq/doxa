# Generation Model Routing, Cost Telemetry, and MDX Repair Design

## Goal

Make hosted documentation generation cheaper, faster to debug, and more resilient by:

- using `x-ai/grok-4.5:nitro` for analysis and structure;
- using `moonshotai/kimi-k2.6:nitro` for page writing and repair;
- persisting exact provider usage without exposing it in the customer dashboard;
- retaining failed MDX diagnostics for a bounded period; and
- repairing local MDX syntax failures without regenerating an entire page.

## Constraints

- Cost telemetry and repair diagnostics are internal. They must never be added to customer job events, public generation DTOs, dashboard routes, or web components.
- Model configuration is immutable after job admission.
- Both default model identifiers use OpenRouter's `:nitro` routing suffix.
- Failed drafts are private R2 objects retained for seven days.
- Structured repair diagnostics are retained for 30 days.
- Usage and cost records are retained for 90 days.
- A repeated telemetry delivery must not duplicate cost, while a repeated provider call must be counted.
- Existing uncommitted model-default changes must be preserved and deliberately migrated.

## Model Configuration

`GenerationExecutionConfig` becomes:

```ts
interface GenerationExecutionConfig {
  plannerModel: string;
  writerModel: string;
  generationProfile: GenerationProfile;
  planningFingerprint: string;
  writingFingerprint: string;
  generatorFingerprint: string;
}
```

The API resolves this once at admission from:

```env
DOXA_PLANNER_MODEL=x-ai/grok-4.5:nitro
DOXA_WRITER_MODEL=moonshotai/kimi-k2.6:nitro
```

`DOXA_AGENT_MODEL` remains a temporary compatibility fallback for deployments
that have not set the two new variables. New jobs persist both explicit model
roles. Analysis and structure requests use `plannerModel`; write requests use
`writerModel`. Repair inherits `writerModel`.

The planning fingerprint covers the planner model, generation profile,
analysis/structure contract versions, and page ceiling. The writing fingerprint
covers the writer model, writer handoff version, writer prompt policy, MDX
validation policy, and component contract. The combined generator fingerprint
provides immutable version traceability.

## Planner-to-Writer Handoff

The structure result includes a versioned `WriterHandoffManifest` constructed
deterministically from accepted analysis and structure state:

```ts
interface WriterHandoffManifest {
  schemaVersion: 1;
  sourceRevision: string | null;
  project: {
    name: string;
    slug: string;
    audience: string;
    documentationGoal: string;
  };
  shared: {
    terminology: string[];
    factualConstraints: string[];
    editorialConstraints: string[];
    validationConstraints: string[];
  };
  pages: WriterPageBrief[];
}
```

Each `WriterPageBrief` identifies the page, route, purpose, required topics,
source evidence, page relationships, reference metadata, and exclusions.
Writing batches receive the shared contract plus only their requested page
briefs. The writer prompt explicitly requires implementing the brief, preserving
the accepted structure, using source evidence only, and returning complete MDX.

## Usage and Cost Telemetry

Usage capture is request-scoped. `AgentOptions` receives a usage callback
instead of relying on the process-global subscriber set. Each model iteration
emits a `GenerationUsageRecord` with:

- a caller-generated `callId`;
- job, stage, stage-execution, operation, and model role;
- page ID/title, page retry, writer attempt, and iteration when applicable;
- exact model and provider generation ID;
- prompt, completion, total, cached, cache-write, and reasoning tokens;
- provider total/input/output/upstream costs when present;
- duration, finish reason, timestamp, and expiry.

The container streams usage records separately from generation events. The
Worker persists them through an internal RPC with `callId` as the idempotency
key. A duplicated stream/RPC delivery is ignored; a newly executed provider
request has a new `callId` and is counted.

The Worker logs stage and final summaries with `console.log`. It does not call
`addJobEvent` for usage, and no customer-facing API reads the telemetry table.
Missing provider costs remain `null` and are reported as incomplete rather than
estimated.

## Repair Diagnostics

Every failed page validation emits a bounded `GenerationRepairDiagnostic`:

```ts
interface GenerationRepairDiagnostic {
  diagnosticId: string;
  jobId: string;
  stageExecutionId: string;
  pageId: string;
  pageTitle: string;
  pageRetry: number;
  attempt: number;
  model: string;
  rule: string;
  message: string;
  line: number | null;
  column: number | null;
  snippet: string | null;
  draftSha256: string;
  draft: string;
  draftTruncated: boolean;
  repairKind: "none" | "deterministic" | "model_patch";
  repairSucceeded: boolean | null;
  createdAt: string;
}
```

The container sends the diagnostic record before its ephemeral workspace is
removed. The Worker writes the failed draft to
`_generation-diagnostics/<jobId>/<diagnosticId>.mdx` and persists metadata
without the draft body. Drafts are capped at 256 KiB and expire after seven
days. Metadata expires after 30 days.

## Targeted MDX Repair

Parser failures with a line and column enter `MdxRepairEngine` before the normal
whole-page retry:

1. Save the original failed draft and exact diagnostic.
2. Convert line and column to a source offset.
3. Attempt one allowlisted deterministic local edit.
4. Revalidate the entire page.
5. If the edit is unsafe or unsuccessful, ask the writer model for a bounded
   structured patch.
6. Validate patch bounds and draft hash, apply it locally, and revalidate.
7. Accept only a fully valid page and preserve every failed repair diagnostic.

The deterministic allowlist initially handles invalid literal `<`, `&`, `{`,
and `}` characters in prose. It does not edit fenced code, inline code,
frontmatter, or valid JSX.

The model repair response is:

```ts
interface MdxRepairPatch {
  startOffset: number;
  endOffset: number;
  replacement: string;
  explanation: string;
}
```

The patch must overlap the parser location and stay within a small bounded span.
The model never regenerates the full page during this repair path. One
deterministic pass and at most two model patch attempts are allowed. Known local
parser failures do not trigger from-scratch page regeneration; unknown or
non-local quality failures continue through the existing page retry policy.

## Storage

PostgreSQL adds:

- immutable planner/writer model and stage fingerprint columns on
  `generation_jobs`;
- `generation_usage_records`, retained for 90 days; and
- `generation_repair_diagnostics`, retained for 30 days.

R2 stores failed drafts under a private prefix with a seven-day prefix-scoped
lifecycle rule. Repository cleanup methods delete expired database records in
bounded batches and run from the existing Worker scheduled handler.

## Verification

Tests must prove:

- admission persists both Nitro model identifiers;
- environment changes do not alter an admitted job;
- analysis/structure use the planner and writing/repair use the writer;
- changing only the writer does not invalidate planning compatibility;
- concurrent pages cannot mix usage attribution;
- repeated telemetry delivery is idempotent;
- actual provider retries are counted separately;
- cost data never enters job events or dashboard DTOs;
- failed drafts survive container cleanup in private R2;
- retention cleanup removes only expired records;
- deterministic repairs preserve code/JSX and fix allowlisted prose errors;
- model patches are local, bounded, hash-checked, and fully revalidated; and
- the writer handoff contains the accepted page contract and relevant evidence.
