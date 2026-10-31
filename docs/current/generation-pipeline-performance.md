# Generation Pipeline Performance

Status: Tasks 12 of 12 complete. The Task 10 comparison was run manually by the
user, who accepted the result; hosted containers therefore default to
`evidence_first`, with `DOXA_WRITER_EXPLORATION=agentic` as the rollback switch.
Task 13 is explicitly excluded pending separate user authorization. The
page-cache lifecycle policy is approved and applied separately from application
deployment. A post-plan corrective review completed additional correctness,
latency, cost, and observability fixes.

## Current generation-stage telemetry

Every hosted analysis, structure, and write stage records exactly one
performance summary, including failed stage requests. Performance telemetry is
operator diagnostics, so it deliberately stays out of the customer-facing job
event stream and out of the dashboard generation log. Each summary is written
twice:

- one NDJSON line on container stdout, tagged
  `"eventType": "generation_performance_summary"` — visible in the terminal for
  local runs and through container logs or `wrangler tail` for hosted runs;
- one appended line in
  `.artifacts/generation-performance-logs/<jobId>.jsonl`, matching the
  repository's existing synthetic-run log convention.

`DOXA_PERFORMANCE_LOG_DIR` redirects the file destination. A hosted container
filesystem is ephemeral, so treat the stdout copy as the durable one for hosted
runs and the file as the durable one for local and synthetic runs. Log failures
are reported and swallowed; they can never fail a generation or mask a stage
error.

The summary reports:

- stage wall time and repository preparation time;
- model, tool, and MDX-validation call counts and durations;
- merged busy time across overlapping spans and separate peak concurrency for
  model, tool, and validation spans;
- pages that used sufficient preassembled evidence and pages that fell back to
  the agentic writer;
- the slowest model call;
- timings grouped by model operation or tool/validator name;
- unattributed container, I/O, and scheduling time.

Per-category durations remain additive work totals, and spans nest: a
`validate_page` tool span contains the `mdx_compile` validation span it
triggers, so `toolMs` and `validationMs` describe overlapping work rather than
disjoint work. Never sum the categories or compare that sum against `wallMs`.
`busyMs` is the union of all span intervals, so nested and concurrent work is
counted once, and it is the only figure to compare against wall time.
`unattributedMs` is wall time minus snapshot time and merged busy time; it is
no longer forced to zero merely because additive span totals exceed wall time.

`evidenceFirstPages` and `agenticFallbackPages` count resolved page modes, not
writer attempts. A page retry or quality repair therefore cannot inflate the
stage coverage totals.

The shared agent accepts a request-scoped `onSpan` callback. It emits:

- one model span for every provider iteration;
- one tool span for every executed server tool;
- one validation span for every MDX compiler invocation.

Span and usage sinks are best-effort. A telemetry callback failure is logged
and never changes generation output or failure behavior. Cached tool
invocations emit one tool span, with `reused: true`, rather than a cache-wrapper
span plus an outer execution span.

Hosted usage preserves an absent model-call duration as nullable `null`.
Unknown latency is never recorded as a fabricated zero-duration request.

## Baseline

The deterministic seed-1729 structural baseline is recorded in
[`../superpowers/plans/2026-07-29-generation-pipeline-performance-baseline.md`](../superpowers/plans/2026-07-29-generation-pipeline-performance-baseline.md).
The local provider is stubbed, so the table is for call counts and relative
non-model work rather than production latency.

## MDX validator worker pool

MDX compilation now uses a bounded pool of long-lived Node workers instead of
starting a new Node process for every validation.

- Pool size defaults to `clamp(cpuCount - 1, 1, 4)`.
- `DOXA_MDX_VALIDATOR_POOL_SIZE` can override the computed default. An explicit
  constructor size takes precedence over the environment.
- Requests use NDJSON over worker stdin/stdout and are correlated by UUID.
- Each worker handles one active request; queued work is dispatched FIFO.
- A worker exit, process error, timeout, malformed response, or mismatched
  response ID returns the existing hard `validator-crashed` result.
- Failed workers are removed and the next request starts a replacement.
- If replacement dispatch cannot start a worker, every queued request is
  resolved with the existing fail-closed `validator-crashed` result; no queued
  validation promise is left hanging.
- An explicit validator script path or non-default timeout keeps using the
  one-shot path, preserving existing test and caller semantics.
- The one-shot validator is used only when the shared pool cannot start.
  Request timeouts, worker exits, and malformed worker output remain one
  fail-closed `validator-crashed` result and are not repeated on the one-shot
  path.

The one-shot validator and pooled server share the same MDX compilation and
diagnostic-mapping module, so rule, line, column, message, and snippet output
cannot drift between the two paths.

Container startup warms and verifies the pool. Concurrent stage requests
reference-count ownership of the process-wide pool. A finishing stage releases
its ownership without blocking or destroying workers used by a sibling; the
final release disposes the pool. The legacy whole-job path retains unconditional
cleanup because it owns the complete run. Disposal waits for active validation
work rather than killing it.

The seed-1729 structural baseline kept six validation calls while reducing
their combined measured time from 1,058 ms to 518 ms. This is a local
stub-provider result and does not claim the same percentage in production.

## Continuous page worker pool

Page writing inside one container stage now uses a continuous bounded worker
pool. When any page settles, the freed worker immediately starts the next page;
a slow page no longer blocks unrelated pages at a fixed slice boundary.

- `config.concurrency` remains the single page-concurrency limit.
- Page checkpoints and progress events still stream in completion order.
- Returned pages are kept in documentation-structure order.
- Writer failures are collected by the pool, then processed sequentially in
  structure order so retry, skip, and abort decisions remain deterministic.
- Cancellation stops new pages from being scheduled. In-flight writers finish
  or observe their existing abort signal, while unstarted pages carry the same
  abort reason.

The seed-1729 synthetic workflow still produced the same three pages and
navigation manifest with 11 model calls. Its largest write stage contains only
two pages at concurrency two, so it verifies behavior and output stability but
is not a meaningful throughput benchmark for this change.

Concurrent output-path resolution is also race-safe. If one writer observes a
missing output directory while another creates it, the first writer retries
canonical resolution instead of misclassifying the new directory as an unsafe
path. Broken symlinks and paths outside the project root remain denied. A
stress regression resolves multiple page paths while their shared directory
is created.

## Concurrent stage isolation

Multiple stage requests for one generation job are now safe to run in the same
container process.

- Every stage execution uses
  `.workspaces/<job>/stages/<stage>-<stageExecutionId>` for its mutable
  artifacts and cleanup boundary.
- All executions for the job continue to share
  `.workspaces/<job>/source` and its exact checkout.
- Snapshot marker validation and snapshot preparation are serialized per
  destination in-process. Concurrent callers reuse the first completed clone
  instead of deleting and rebuilding the same source directory.
- The same stage execution ID now identifies its workspace, timing summary,
  usage records, and repair diagnostics.
- Active requests are tracked as a set per job. Cancelling a job aborts every
  in-flight stage request, unregistering one request leaves its siblings
  registered, and the existing cancellation tombstone still rejects late
  deliveries.

Stage cleanup removes only that execution's stage root. It never removes the
shared source snapshot. The container isolation suite includes an interleaved
cleanup regression, a concurrent real-Git snapshot regression, and
multi-controller cancellation coverage.

## Parallel Workflow write batches

Both the legacy and revision-aware Workflows now dispatch write batches through
the same bounded scheduler.

- `DOXA_WRITE_BATCH_PARALLELISM` controls concurrent batch steps.
- The runtime defaults to `2` and clamps configured values to `1..4`.
- Each batch keeps its existing unique durable `step.do` name.
- Batch results and page checkpoint keys are assembled by batch index, not
  completion order.
- The first failure or cancellation stops new batches from being admitted.
  Already-started durable steps are awaited before the original error is
  rethrown, preventing dangling promises and unhandled rejections.
- The selected parallelism is included in the workflow-started job event.

The writing feasibility budget now uses
`ceil(batchCount / batchParallelism) * pageBatchTimeoutMs`. Both runtime paths
evaluate this parallel-wave budget before dispatch, including the configured
finalization reserve.

The seed-1729 synthetic workflow started both write steps at 520 ms, before
either completed. It still published the same three pages, seven runtime
artifacts, seven permanent-state artifacts, navigation, and 11 model requests.
No deployment configuration was changed; the runtime default supplies
parallelism two until an explicit environment override is approved.

## Stable writer prompt prefix

All pages in one generation job now use a byte-identical writer system prompt.
Shared context moved out of the per-page user message and into modular
writer-system sections:

- project analysis summary;
- complete documentation structure;
- canonical generated-route registry;
- normalized public editorial brief;
- job-wide planner handoff project and shared context;
- description-writing instructions;
- component playbook.

The user message remains page-scoped and contains the assigned page identity,
description, page type, relevant data, source evidence, only that page's
planner-handoff brief, numbered writing instructions, and retry feedback. The
generic writer path is unchanged because shared-context modules are enabled
only by the structured documentation writer.

Tests assert both prompt-content parity and the actual provider boundary:
every page-write request in a multi-page generation has the same system prompt,
while the separate navigation-planner request remains intentionally distinct.
No explicit provider `cache_control` fields were added; compatible OpenRouter
providers can use their automatic stable-prefix caching.

The synthetic provider still selected each intended page from its user message
and published the unchanged three-page artifact set with 11 model requests.

## Repository tool-result cache and search limits

Every `generateDocumentation` invocation now owns one bounded, read-through
cache shared by its page writers. The cache is not shared across stage
requests, generation jobs, or repository snapshots.

- Cache keys hash the tool name and canonical, key-order-independent JSON
  arguments.
- The cache retains at most 256 results and evicts the least recently used
  entry.
- Results larger than 64,000 characters bypass storage.
- Concurrent identical requests share one in-flight computation, so parallel
  pages do not race and repeat the same repository operation.
- Cache hits emit a tool span with `reused: true`.
- Read, Glob, and Grep dependency recording runs after resolution, including
  cache hits. Cached pages therefore retain the same `sourceFilesRead` and
  `sourceFilesDiscovered` evidence used for future invalidation.

Repository search is bounded independently of the cache:

- Grep ignores binary files and excludes `.git`, `node_modules`, `dist`,
  `build`, `.next`, and `coverage`.
- Every Grep command has a 10-second timeout. A timeout becomes a normal tool
  error string instructing the writer to narrow its path or pattern; it does
  not escape the tool boundary as an exception.
- Glob skips the same generated, dependency, and metadata directories while
  walking the repository.
- Grep still retains its existing 80-line output limit.

Unit coverage verifies canonical keys, oversized-result bypass, LRU eviction,
concurrent request coalescing, cache-hit spans, dependency equivalence between
cached and uncached pages, exact Grep exclusions, timeout translation, and
Glob exclusions. The full 249-test agent suite, repository typecheck,
production agent build, and three synthetic generation scenarios pass.

## Parallel whole-document quality repair

Whole-document quality repair now works in bounded rounds instead of repairing
one page at a time.

- Blocking issues are grouped by their target page in documentation-structure
  order.
- Pages that have exhausted their per-page budget are not admitted to another
  repair round.
- A round admits no more pages than the remaining global repair budget.
- User retry, skip, and abort decisions remain serial and deterministic.
- Retry candidates are generated concurrently through the shared bounded page
  pool using `config.concurrency`.
- A generated candidate consumes one global repair attempt whether writing
  succeeds or fails, preserving retry accounting.

Candidate completion order never controls acceptance. After all writers in a
round settle, candidates are assessed serially in documentation-structure
order. Each candidate is validated by replacing its page in the latest
accepted page set, so link and cross-page rules see all earlier accepted
repairs. Only an improving candidate is persisted and checkpointed. Rejected
candidates leave the last accepted draft unchanged and feed their rejection
reason into that page's next repair prompt.

The complete accepted page set is revalidated once after all candidates in the
round have been assessed. For three independently failing pages, regression
coverage verifies three concurrent candidate writes and five validator calls:
one initial validation, three candidate assessments, and one round
revalidation. The former serial loop required seven calls.

Regression coverage also verifies:

- identical output and failure ordering when model responses complete in
  opposite orders;
- the existing per-page exhaustion error and retry cap;
- rejection when a candidate fixes its local rule but introduces a broken
  cross-page link;
- preservation of the accepted file when a candidate is rejected;
- writer-invalid candidates remaining inside the docs-quality budget.

The full 252-test agent suite, repository typecheck, production agent build,
and seed-1729 synthetic workflow pass. The synthetic workflow still publishes
the same three pages with 11 model requests.

## Targeted mechanical page repair

The writer can now route one isolated hard validation failure through the
existing bounded model-patch path before paying for another complete page
generation.

`WriterValidationConfig.targetedRepairClasses` accepts:

- `mdx` for a located MDX parser failure;
- `frontmatter` for residual or malformed metadata;
- `description` for a genuine frontmatter-description validation error with a
  concrete location;
- `length` for an otherwise valid page below the minimum body length.

The shared agent default remains `["mdx"]`, so existing embedded and local
callers retain the previous behavior unless they opt in. The hosted container
profile explicitly enables all four classes and keeps `maxAttempts: 3`.

Targeted repair remains narrow:

- exactly one hard issue must map to an enabled repair class;
- accompanying soft warnings do not prevent repair, but the patched full page
  must pass every validation before acceptance;
- frontmatter and description repairs target the relevant metadata line;
- length repairs target an insertion at the end of the accepted draft;
- every patch remains hash-bound, offset-bounded, and limited to the existing
  2,048-character replacement ceiling;
- MDX repair exhaustion retains its previous behavior.

A successful targeted repair returns the validated patched page without
another full writer call. If a mechanical repair fails, the pipeline records
the original issues in `ValidationHistoryEntry` and enters the existing full
regeneration path. Regression tests compare the resulting frontmatter and
length retry hints byte-for-byte with repair disabled. Repair diagnostics
include the selected repair class, original rule, patch result, rejection
reason, and post-patch issue codes.

Coverage exercises successful and failed repair for every newly enabled class,
the MDX-only default, unchanged MDX failure accounting, full-regeneration
fallback, and hosted-profile opt-in. The full 260-test agent suite,
103-test container suite, repository typecheck, production agent build, and
seed-1729 synthetic workflow pass with the same three pages and 11 model
requests.

The pipeline no longer fabricates a description issue merely because the raw
writer body omitted frontmatter. Validation composes the structure-supplied
description first; if that composed page is valid, it is accepted in one
writer call with no targeted repair. Description validation now uses the
ordinary `frontmatter` repair class; the unreachable standalone `description`
class has been removed from the public type, classifier, prompts, and hosted
profile.

## Evidence-first writer

The writer now supports two explicit exploration modes:

- `agentic` preserves the current repository-exploration loop with `Read`,
  `Glob`, `Grep`, and `validate_page`, capped at 12 model steps;
- `evidence_first` builds a deterministic page evidence bundle before the
  model call. When the bundle is sufficient, the writer exposes only
  `validate_page` and caps the loop at two model steps. An insufficient bundle
  automatically falls back to the unchanged agentic path.

The shared agent library still defaults to `agentic` for embedded callers.
Hosted containers default to `evidence_first`. Setting
`DOXA_WRITER_EXPLORATION=agentic` is the production rollback switch; an unset,
empty, `evidence_first`, or unrecognized value retains the hosted
`evidence_first` default. A page whose bundle is insufficient still falls back
to the complete agentic tool loop automatically.

When the evidence bundle is sufficient, the page instruction explicitly tells
the writer to ground every claim in `SOURCE EVIDENCE` and not assert behavior
the evidence does not show. It no longer asks a validation-only writer to
explore the repository with unavailable tools.

### Evidence bundle contract

Each bundle contains the page ID, repository-relative paths actually read,
rendered prompt context, an explicit sufficiency result, and a human-readable
reason. Evidence is assembled in stable order:

1. the page or subpage's declared `sourceEvidence`;
2. source paths from the matching writer-handoff brief;
3. evidence backfilled from the resolved REST or SDK reference surface.

Duplicate paths retain their first position. Each file is capped at 4,000
characters and the complete evidence content is capped at 18,000 characters.
Missing and unreadable files are skipped and reported. Every path is resolved
through the repository containment boundary, so traversal and escaping
symlinks remain hard failures.

A bundle is sufficient only when it contains at least one readable file and
either:

- the page reference resolves to its analyzed REST group/endpoint or SDK
  module/export; or
- the writer handoff has a non-empty required topic backed by a handoff
  evidence path that was actually read.

This is a deterministic rule, not a model confidence score.

Explicit agentic mode still receives the original page-only evidence context
byte-for-byte. Richer handoff and reference backfill is limited to the
evidence-first path.

### Dependency safety and retries

Bundle construction is memoized per page for a generation invocation. Paths
read into the bundle are merged into `dependencies.sourceFilesRead`, even when
the writer makes no repository tool calls, so a page written without tools
still records the sources it was built from.

That recorded set is now bounded by what planning declares. A validation-only
page contributes exactly its bundle paths — declared `sourceEvidence`, writer
handoff paths, and resolved reference-surface backfill — where an agentic page
also contributes whatever its tools happened to read. Revision-aware
invalidation is therefore precise to the extent the structure stage declares
evidence: a page whose evidence under-declares a real dependency can be left
out of `regeneratePageIds` when that file changes, and serve stale content on a
later preview. Making evidence-first the hosted default widened the reach of
this pre-existing behavior, so it is a watch item rather than a settled
property. Monitor it with the per-stage `evidenceFirstPages` and
`agenticFallbackPages` counters, and compare recorded dependency counts against
an agentic run for the same repository before treating a low fallback rate as
success.

Only the exploration surface and model-step ceiling change. Writer attempts,
token budgets, loop finalization, server-side validation, targeted repair,
whole-page regeneration, whole-document quality repair, and cancellation
semantics are unchanged.

### Verification

Regression coverage proves:

- deterministic evidence ordering and character caps;
- missing/unreadable reporting and path-containment enforcement;
- one immediate model response with only `validate_page` for sufficient
  evidence;
- a two-step forced-finalization ceiling for sufficient evidence;
- the full tool surface and 12-step ceiling for insufficient evidence;
- unchanged agentic behavior when the setting is omitted;
- evidence paths populating page dependencies without tool calls;
- hosted configuration defaulting to evidence-first with an explicit agentic
  rollback;
- per-stage reporting of evidence-first pages and agentic fallbacks without
  retry double-counting.

The repository-wide test suite passes: 276 agent tests, 111 container tests,
106 worker tests, 266 API tests, and all other workspace suites. Repository
typechecking and the production agent build pass.

Seed 1729 passes in both modes with the same three pages and 11 total model
requests:

```bash
pnpm test:generation:synthetic -- --seed 1729 --runs 1
DOXA_WRITER_EXPLORATION=evidence_first \
  pnpm test:generation:synthetic -- --seed 1729 --runs 1
```

The synthetic provider intentionally calls `validate_page` before returning
each final page, so both modes use two writer requests per page. It verifies
orchestration, tool exposure, validation, dependencies, and output stability,
but cannot demonstrate the required production model-call reduction.

The user ran the live comparison manually and accepted the result, which is why
hosted containers now default to `evidence_first`. Task 10 is complete. Re-run
the same checks whenever the writer model, the evidence bundle, or the
sufficiency rule changes:

- no new blocking whole-document quality issues;
- no average per-page word-count reduction greater than 20%;
- at least a 50% reduction in per-page model calls.

## Combined planning stage

Repository analysis and documentation-structure creation now run in one
container request by default. The workflow sends a `plan` request to
`/stages/plan/stream`; the container prepares the exact repository snapshot
once, then runs the existing analysis and structure operations in their
original order.

The shared implementation is additive:

- `analysis`, `structure`, and `write` remain valid stage contracts and routes;
- `DOXA_PLAN_STAGE_ENABLED=0` selects the original two-request path;
- an unset value, an empty value, or any value other than exactly `0` enables
  the combined stage;
- the combined Workflow step uses a new durable step name. Workflows already
  in flight on the old step identities finish on the old path;
- its timeout budget is the configured analysis timeout plus the configured
  structure timeout, still bounded by the overall generation deadline.

The combined result contains both checkpoints, page IDs, deterministic
navigation, writer handoff, and a SHA-256 page-input hash for every page. On
revision-aware runs it also carries the source snapshot, source state,
analysis state, preliminary plan, structural fingerprint, final incremental
plan, and structure state.

The worker still writes the same two R2 checkpoint objects:

- `*-analysis.json` has the existing successful `analysis` result shape;
- `*-structure.json` has the existing successful `structure` result shape.

Write and finalization steps therefore consume the same durable formats as
before. Dashboard progress also remains stable because the combined request
still emits `analysis_started`, `analysis_complete`, `structure_started`,
`structure_review_started`, and `structure_created`.

### Verification

Container regressions compare the combined stage with sequential analysis and
structure using the same deterministic provider. They assert equal analysis
and structure checkpoints, page IDs, page-input hashes, navigation, and
progress events. The combined path prepares one workspace snapshot; the
legacy comparison prepares two.

The end-to-end synthetic production workflow verifies:

- exactly one pre-write `plan` transport request and no separate analysis or
  structure request by default;
- both revision-aware R2 checkpoint shapes still contain their analysis and
  structure state;
- `DOXA_PLAN_STAGE_ENABLED=0` makes exactly one analysis request followed by
  exactly one structure request;
- combined and legacy checkpoint contents are equal after normalizing the
  independently created fixture commit IDs;
- both paths publish the same three pages and retain 11 model requests.

Current verification passes with 276 agent tests, 111 container tests, 106
worker tests, and 75 generation-package tests. Repository-wide typechecking,
the production agent build, and the seed-1729 synthetic workflow also pass.

## Content-addressed page cache

Revision-aware generation now keeps a two-tier, content-addressed page cache
under `cache/pages/` in the existing docs R2 bucket. This cache complements,
rather than replaces, baseline artifact reuse and durable write-step
checkpoints. It helps when planning churn marks an otherwise unchanged page
for regeneration, baseline state is unavailable, related preview runs share
unchanged inputs, or an explicitly enabled preview reuses another writer
model's output.

The cache is never consulted or written unless the analysis result contains
per-file `sourceState`. The legacy generation path has no exact snapshot state
and therefore retains its original behavior without an invented fallback
digest.

### Cache identity

Every key includes:

- the site ID, preventing cache sharing between tenants or repository forks;
- the key version (`PAGE_CACHE_KEY_VERSION`, now 2);
- the page ID and page-input hash from the final structure;
- the public-documentation policy version;
- a hash of the sorted canonical route registry, invalidating pages whose
  already-rewritten internal links may reference a changed sibling route;
- a dependency digest derived from the page's declared source evidence plus
  prior `sourceFilesRead` and `sourceEvidenceFiles` when baseline state exists;
- the applicable writing contract.

The key holds only the page's own inputs. Version 1 also held the analysis
hash and the structural fingerprint, so a new plan of the same code changed
every key and a re-run found nothing. A page is written to the cache as soon
as it checkpoints, so a batch that fails later keeps its written pages.

Dependency paths are sorted and deduplicated. Each path is paired with its
content hash from the current exact source snapshot; a missing path contributes
the explicit `absent` sentinel. A dependency-content change therefore changes
the key even when the page-input hash is unchanged.

The exact tier uses the job's full writing fingerprint, including its writer
model. The cross-model tier uses only the shared writing and handoff contract.
The API now imports these version constants from the contracts package, while
the resulting full writing-fingerprint string remains byte-for-byte unchanged.

### Read and write policy

For every pending page, the Workflow:

1. honors any existing durable per-page checkpoint;
2. checks the exact-model key;
3. for exact misses only, optionally checks the cross-model key;
4. writes valid hits into the existing page-checkpoint store;
5. sends only remaining misses to the container writer;
6. writes both cache tiers only after a successful fresh generation response.

Reusable baseline state, the structure checkpoint, source-file hashes, and
page descriptors are prepared once for the complete write phase. Each batch
receives only its narrowed descriptor view, avoiding repeated R2 reads and
checkpoint parsing on the write critical path.

Cross-model reads require both `DOXA_PAGE_CACHE_CROSS_MODEL=1` and preview
publication mode. Production never reads that tier, ensuring a writer-model
change actually regenerates production prose. A cross-model hit emits
`page_cache_cross_model_hit` with the page ID, cached model, and current model,
and is never copied into the current model's exact key.

Every successful write batch also logs one
`generation_page_cache_summary` line to worker stdout with `pageCount`,
`exactHits`, `crossModelHits`, and `generated`. The difference between
`pageCount` and those three counters represents pages already satisfied by
durable write checkpoints. Like the stage performance summary, this is operator
diagnostics rather than a job event; Workers have no filesystem, so read it via
`wrangler tail doxa-agent-worker` alongside the container's
`.artifacts/generation-performance-logs` NDJSON.

R2 read failures, malformed or truncated entries, cache-preparation failures,
write failures, and event-persistence failures are all non-fatal. They degrade
to normal page generation without changing the generation result.

### Controls, verification, and storage

- Cache reads and writes are enabled by default.
- `DOXA_PAGE_CACHE_ENABLED=0` disables both tiers and restores the previous
  write-batch behavior.
- Leaving `DOXA_PAGE_CACHE_CROSS_MODEL` unset disables only cross-model reads;
  both tiers are still populated by fresh pages.

Regression coverage verifies every key field, tenant isolation, dependency
ordering and invalidation, missing-versus-empty files, schema validation,
corrupt-entry fallback, exact hits with no writer call, partial hits, stable
page order, preview-only cross-model gating and attribution, no exact-key
laundering, two-tier writes for fresh pages, disabled/no-context behavior, and
the unchanged writer-fingerprint format.

Current verification passes with 266 API tests, 106 worker tests, 75
generation-package tests, and repository-wide typechecking. Seed 1729 still
publishes the same three pages with 11 model requests; its first run writes six
cache objects, exactly `2 × 3 pages`.

The approved lifecycle policy is intentionally restricted to the
`cache/pages/` prefix in the `doxa-docs-artifacts-enam` bucket, expires objects after
30 days, and uses rule ID `doxa-page-cache-expiry`. It must never be broadened
to the bucket root because versioned documentation artifacts share this
bucket. The rule was installed and verified through Wrangler on 2026-07-30;
the pre-existing bucket-wide multipart-abort rule remains unchanged.
All lifecycle rules, including this one and the `cache/plans/` rule, are now
defined in `packages/contracts/src/storage-lifecycle.ts`; see
[Storage Garbage Collection](storage-garbage-collection.md#r2-lifecycle-rules).
A cache read rewrites an entry uploaded 20 or more days ago, so a hot entry
does not expire.

Expiration only turns a future lookup into a cache miss; it cannot change
generation correctness. The 30-day window can be revisited after
`generation_page_cache_summary` logs provide real hit-age data. To roll back only
this rule with the current Wrangler CLI:

```bash
npx wrangler r2 bucket lifecycle remove doxa-docs-artifacts-enam \
  --id doxa-page-cache-expiry
```

## Final artifact link warnings

Both durable finalization paths inspect generated Markdown and MDX links after
artifact-shape validation. An absolute internal destination that is absent
from the finalized navigation emits an `artifact_link_warning` job event with
the source page and missing route.

This inspection is diagnostic-only. Link findings, inspection failures, and
warning-event persistence failures never block artifact upload or publication.
External URLs, same-page fragments, and image destinations are ignored.
Regression tests cover a clean bundle, a missing route, query/fragment
normalization, and duplicate-warning suppression.

## Post-plan corrective verification

The 2026-07-30 corrective review passes:

- repository-wide `pnpm typecheck`;
- 276 agent tests;
- 111 agent-container tests;
- 106 agent-worker tests;
- 266 API tests;
- 75 generation-package tests;
- the production agent build;
- the fixed seed-1729 synthetic scenario with three pages and 11 model
  requests;
- the unparameterized three-scenario synthetic suite.

## Published-structure continuity and post-structure page reuse

Structure regeneration is anchored to the currently published structure when
a compatible baseline exists. The planner and structure reviewer receive the
published page identity, section placement, ordering, and the exact changed
source paths. Unchanged subjects keep their published IDs, titles,
descriptions, and placement; additions, removals, or moves must be justified by
the source delta. Cold-start structure prompts remain unchanged.

Page fate is decided after the regenerated structure is finalized. A
preliminary full-plan verdict can require analysis and structure work, but it
no longer automatically forces every resulting page through the writer. The
final pass compares each current page with the published baseline and:

- regenerates new pages and pages whose canonical input hash changed;
- regenerates pages whose dependency ledger intersects any changed source
  path, including paths excluded by the earlier relevance trigger;
- reuses pages whose identity, inputs, and dependencies remain compatible;
- records pages removed from the regenerated structure separately;
- regenerates every current page if documentation-relevant changes exist but
  no page dependency explains them.

Planning-fingerprint changes still require a full regeneration. A
writing-fingerprint change keeps the rebuilt structure but rewrites every
page. The ordinary structure-reuse path retains its existing planning logic.

The final comparison uses `buildPageInputHashMap`, the same canonical hash
representation emitted by the structure checkpoint and persisted on written
page state. This avoids comparing production page hashes with the separate
legacy planning hash representation. `analysis_complete` reports the first
preliminary reason, while `structure_created` reports the final reason plus
reuse and regeneration counts.

The required same-repository, same-revision, two-run check produced 100%
stable page-input hashes with one repository and one planner. A second
repository remains useful confirmation, although the continuity mechanism is
deterministic code over cached analysis rather than a prompt-only preference.
Regression coverage includes anchored prompt retries, review keep-bias,
new/changed/dependency-hit/reused/removed pages, planning and writing contract
mismatches, the unexplained-change safety fallback, and the one-dependent-page
result of one regeneration plus nine reuses.

Fresh verification passes repository-wide typechecking, 290 agent tests, 123
agent-container tests, 106 agent-worker tests, 266 API tests, 75 generation
tests, the production agent build, the Worker dry-run bundle, and all three
standalone synthetic generation scenarios.

## Model-call idle and maximum-duration deadlines

Model-call timeouts now distinguish an inactive stream from a long but healthy
generation. Each model iteration owns two independent deadlines:

- a 120-second idle deadline, reset whenever the provider emits a chunk;
- a 600-second absolute ceiling, measured from the start of the iteration and
  never extended by stream activity.

The first deadline to expire aborts only that model call. `ModelCallTimeoutError`
keeps its existing name, iteration, and `timeoutMs` fields, and adds `kind` so
operators can distinguish `idle` from `max_duration` without parsing text. All
terminal middleware events and the outer `finally` cleanup clear both timers.
Workflow retry settings are unchanged because either timeout can still be a
transient provider failure.

Both budgets are part of `AgentConfig` and reach analysis exploration and
synthesis, incremental analysis, structure generation and review, page
writing, targeted MDX repair, and navigation ordering. Structure and analysis
retry paths preserve the same values on later attempts. Hosted stage requests
read optional positive integer overrides from:

- `DOXA_MODEL_CALL_IDLE_TIMEOUT_MS`;
- `DOXA_MODEL_CALL_MAX_MS`.

Unset, zero, negative, non-integer, or non-numeric values are ignored so the
agent package defaults remain authoritative. The container wrapper still does
not inject these variables through `AgentContainer.envVars`; therefore the
production deployment uses the package defaults until that separately
approval-gated wiring is added.

Regression coverage includes continuous output beyond the idle window,
silence measured from the most recent chunk, the absolute ceiling on an
indefinitely active stream, per-iteration resets, complete timer cleanup,
AgentConfig propagation, attempt-three retry propagation, and environment
normalization.

## Reliability and cost controls

These controls came from the pipeline research of 2026-10-15. Each one is
provider-neutral: a provider runtime in `packages/agent/src/core/providers/`
supplies the capability, and Anthropic is the only provider that has all of
them today.

| Control | Where | Setting |
| --- | --- | --- |
| Prompt caching: a marker after the system prompt and a moving marker on the newest message of an agent loop. With a caching provider, the first page starts alone so the others read its prefix. | `core/prompt-cache.ts`, `providers/anthropic-prompt-cache.ts` | `DEFAULT_PROMPT_CACHE_POLICY` (5 minutes; `"1h"` is the other value) |
| List-price costs for providers that send none, and `cacheWriteTokens` in stage summaries. A busy stage with no cache read logs `generation_prompt_cache_cold`. | `providers/anthropic-pricing.ts`, agent-worker `generation-observability.ts` | Update the price table when Anthropic changes prices |
| Structured outputs for the structure and structure review calls. A refused schema falls back to plain JSON once and is not sent again. The analysis keeps plain JSON: it has more optional fields than a schema may hold. | `core/structured-output.ts`, `doxa-agent/response-schemas.ts` | None |
| Model call error classes and one retry layer (4 attempts, full jitter) before any output. A spend cap, a bad key or a missing model stops the run. | `core/model-call-errors.ts`, `core/model-call-retry.ts` | `DEFAULT_MODEL_CALL_RETRY_POLICY` |
| A page is the unit of failure: two page retries, the second on the fallback model, then the page is skipped. A run fails only when 80% or more of its pages failed; the others keep their published page or are left out, and appear as flagged pages in the review and on the generation page. | agent `generation-service.ts`, agent-worker `generation-page-failures.ts` | `DOXA_WRITER_FALLBACK_MODEL` (planner model by default), `PAGE_FAILURE_RUN_THRESHOLD` |
| Plan cache across runs under `cache/plans/`, keyed by the plan stage request without job fields. | agent-worker `generation-plan-cache.ts` | `DOXA_PLAN_CACHE_ENABLED=0` turns it off |
| Adaptive writer width per job (start 8, up to the ceiling, halve on a rate limit or overload) and write groups that exist for durability only. | agent `utils/adaptive-concurrency.ts`, agent-container `writer-width.ts` | `DOXA_AGENT_PAGE_CONCURRENCY` (job ceiling, 24), `DOXA_WRITE_GROUP_SIZE` (24) |
| Continue a failed run from its failed step with `instance.restart({ from })`. Offered for 29 days after a transient failure. | agent-worker `workflow-step-tracker.ts`, API `generation-resume.ts` | `GENERATION_RESUME_WINDOW_DAYS` |
| REST endpoint pages from a template, writer step cap 8, topic-matched evidence, section repair, repo map before exploration. | see the sections above and `packages/agent/src/repo-map/` | `AgentConfig.writerMaxSteps`, `AgentConfig.repoMap` |
| Without a spec file, the analysis answer is the REST surface, with every endpoint fact; no model call follows it. The file-by-file extraction was removed after the incident of 30 October 2026. See [API reference sources](api-reference-sources.md#the-model-route). | agent `doxa-agent/analysis-service.ts` | None |

The structure review now reports `structure_review_decided` with the share of
pages it changed. Releasing pages to the writers before the review ends is not
built yet: it pays off only when that share is small, so measure it first.

## Account-wide writer slots

Anthropic rate limits apply to the whole organization. Up to 5 jobs run at
once (queue `max_concurrency` 5, container `max_instances` 5), and each job can
run up to 24 page writers, so a per-job width cannot keep the account under its
limit. The writer slot limiter in `apps/agent-worker/src/writer-slots/` hands
out one shared pool of writer slots to all jobs.

- `WriterSlotLimiter` (`limiter.ts`) is the provider-neutral interface:
  `acquire({ jobId, requested, minimum?, ttlMs })` returns a
  `WriterSlotLease` (`leaseId`, `jobId`, `granted`, `expiresAt`),
  `release(leaseId)` returns the slots, and the optional `renew(leaseId,
  ttlMs)` extends a live lease or returns `null`.
- `WriterSlotPool` (`pool.ts`) holds the allocation rules, with no I/O and an
  injected clock:
  - A job gets `min(requested, free slots, fair share)`, but never less than
    `minimum` (default 1, capped at `requested`). A job never starves while
    the pool is full, so the ceiling is soft by at most `minimum` slots per
    job.
  - Fair share is `ceil(ceiling / active jobs)`. The active jobs are the jobs
    with a live lease plus the job that asks. It limits only a new grant; it
    never takes slots back from a lease.
  - A job has at most one lease. When it asks again, the same lease gets a new
    grant and expiry, and its old grant does not count as used.
  - A lease expires `ttlMs` after its last acquire or renew, so a crashed job
    cannot hold slots. Each call first drops expired leases. Releasing an
    unknown or expired lease does nothing.
- `WriterSlotsDurableObject` (`durable-object.ts`, binding `WRITER_SLOTS`) is
  one named instance (`idFromName("account")`). It keeps the pool in memory,
  writes all leases under one storage key after each change, and loads them
  in `blockConcurrencyWhile` on start, so a restart keeps the leases. Expiry is
  lazy; there is no alarm. Callers use Workers RPC (`acquire`, `release`,
  `renew`). The object validates each request and the client validates each
  response with Zod.
- `resolveWriterSlotLimiter(env)` (`client.ts`) returns the Durable Object
  client when `WRITER_SLOTS` is bound. Otherwise, for example in tests or an
  older deploy, it returns `noopWriterSlotLimiter`, which grants each request
  up to the ceiling and keeps no state.

`DOXA_ACCOUNT_WRITER_SLOTS` sets the ceiling. A missing or invalid value
(not a positive integer) uses `DEFAULT_ACCOUNT_WRITER_SLOTS`, 48. Set it to the
concurrent-request headroom of the account's Anthropic tier. It is not in the
Wrangler vars, so the default applies until an override is approved. A new
ceiling applies when the Durable Object starts again; current leases stay
until they are released or expire.

The workflow integration is a separate change. A write group acquires slots
before it calls the container, passes `granted` as the page concurrency, and
releases the lease in a `finally` block when the group ends. The lease TTL
must cover the whole group: use `PAGE_BATCH_TIMEOUT_MS` plus a short margin.
The maximum TTL is two hours.
A Workflow retry of the same group asks again with the same `jobId` and gets
the same lease back. When one job runs two write groups at once
(`DOXA_WRITE_BATCH_PARALLELISM` above 1), give each group its own key, for
example `${jobId}:batch-${index}`, because one key holds one lease.

Template groups take no writer slot. The worker splits the pages of a write
stage into template groups (REST endpoint pages, up to 500 for each group,
10-minute steps) and model groups (`DOXA_WRITE_GROUP_SIZE`, 24 by default).
Template groups run first. See
[API reference sources](api-reference-sources.md#write-stage-at-scale).

## Stable incremental runs

An incremental run, such as a pull request preview, writes only the pages
that the code change affects. Five rules keep unaffected pages as published.

**Structure modes.** The preliminary plan (`planRevisionAwareGeneration`)
picks one of three modes:

| Mode | When | Structure |
| --- | --- | --- |
| `reuse` | No structural file changed. | The published structure. |
| `patch` | Routes, schemas, a spec file of the published REST reference, or edited package manifests changed. | The published structure, with the REST and SDK reference sections rebuilt from the new analysis (`patchPublishedStructure`). No planner or review call. |
| `regenerate` | A package was added or removed, a docs configuration changed, more than `MAX_STRUCTURE_PATCH_CHANGES` (20) structural files changed, or no published structure is readable. | Planned again, anchored to the published structure. |

After a patch, each page is compared with its baseline record. Unlike a new
plan, a patch never rewrites every page because a relevant change matches no
page dependency: the reference pages already come from the new analysis.

**Reference page identity.** `ensureReferenceSections` adds the reference
pages after the planner. A reference page avoids only the ids and titles of
editorial pages; the reference pages already in the structure are replaced
and reserve nothing. With a published structure, a reference page keeps its
published id and title, matched by `referenceIdentityKey`: the endpoint method
and path, the resource group, the overview or auth page, or the SDK module.
Adding the reference pages again changes nothing.

**Page input hash.** The hash counts evidence as its sorted, unique file paths
and a description as its words (`evidencePaths`, `normalizedBrief`). The
baseline is read with the same rule (`baselinePageInputHashes`): a stored hash
that the baseline structure explains, under the current or the earlier rule,
becomes the current rule's hash, so a rule change rewrites no page. A stored
hash that the structure does not explain, such as one from another renderer,
stays, and the page is written again.

**Planning version.** `PLANNING_FINGERPRINT_VERSION` in `@doxahq/contracts`
must change with the planner's output format. A test in `@doxahq/agent`
compares the structure and review response schemas with
`PLANNER_OUTPUT_SCHEMA_HASH` and fails until both are updated.

**Page edits.** For a page-level plan, `planPageEdits` lists each regenerated
page that the baseline has (`plan.pageEdits`), with its artifact key and the
changed files it depends on. The worker reads those published pages and sends
them as `previousPages` in the write request, and the writer prompt asks for
the smallest change. A template page, a new page, a seeded owner page, and a
plan that rewrites every page on purpose get no edit.

## Pending operational decisions

The post-plan review left these choices visible and intentionally unchanged:

- Deploy `agent-container` before `agent-worker`. The worker's structure-stage
  result schema requires `pageInputHashes` and `routeRegistryHash`; deploying
  the worker first would reject structure responses from an older container.
- The merged plan step has a shared Workflow retry boundary. A structure
  failure therefore repeats analysis and structure. A future checkpoint event
  could let the retry resume from the completed analysis.
- Containers run on `standard-3` (2 vCPU, 8 GiB memory, 16 GB disk), raised
  from `standard-1` (1/2 vCPU) because one container can run two write batches
  with six page writers each plus up to four validator workers. Both the
  top-level and `env.production` container blocks carry the value; changing
  only one is a silent misconfiguration. Use production `busyMs` and the
  per-kind peak concurrency counters to decide whether a further size or
  parallelism change is warranted.
- Evidence-first is the hosted default. Set
  `DOXA_WRITER_EXPLORATION=agentic` to roll back without changing the shared
  agent library's default.
- Model-call idle and maximum-duration overrides are parsed inside the
  container process, but Wrangler configuration cannot inject them until the
  `AgentContainer.envVars` boundary is explicitly wired.
- Parseable structure-review decisions that exhaust the configured three
  attempts degrade to the best structurally usable candidate and emit
  `structure_review_degraded` with the unresolved errors. Exhaustion is
  terminal only when every response is unparseable or when hard feasibility
  validation, such as the default-section rule, fails before review.

## Compatibility and invariants

- Documentation structure, routes, content, navigation, and quality gates are
  unchanged.
- MDX validation remains fail-closed.
- Stage timing emission happens before stage-workspace cleanup.
- Cancellation continues to propagate through model and tool execution.
- Page-level failure choices remain sequential and deterministic.
- Concurrent stage requests share source truth but no mutable artifact root.
- Workflow write results remain deterministic when batches finish out of
  order.
- Shared writer context is stable across pages; page evidence and repair hints
  remain request-specific.
- Tool caching is scoped to one immutable source snapshot and does not change
  page dependency evidence.
- Repository searches have bounded traversal and execution time.
- Quality-repair model calls may run concurrently, but acceptance, persistence,
  failure decisions, and returned page order remain deterministic.
- Whole-document quality validation runs once per repair round after all
  candidate decisions.
- Targeted mechanical repair cannot bypass full-page validation.
- Failed mechanical repair preserves the existing writer retry ledger and
  full-regeneration prompt.
- Evidence-first mode never skips server-side page or document validation.
- Insufficient evidence always restores the full agentic tool loop.
- Evidence bundle reads remain part of page dependency invalidation.
- Hosted writer exploration defaults to evidence-first, while an insufficient
  bundle and the explicit rollback setting retain the complete agentic path.
- Planning uses one container round trip by default without changing the two
  durable checkpoint formats consumed by later stages.
- The original analysis-then-structure path remains available with
  `DOXA_PLAN_STAGE_ENABLED=0`.
- Page cache reuse requires exact snapshot source state and never runs on the
  legacy generation path.
- Exact cache identity preserves writer-model invalidation.
- Cross-model reuse is preview-only, explicitly enabled, attributed, and never
  promoted into the exact tier.
- Cache failures cannot fail paid generation; they become ordinary misses.
