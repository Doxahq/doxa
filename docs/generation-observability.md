# Generation Observability

Doxa generation has two telemetry surfaces:

- Dashboard job events are durable and come from `job_events` in Postgres. Use this first when debugging a user's generation. Read the table itself: the dashboard, the event stream and the MCP `get_generation` tool show only the generation log (`apps/api/src/services/generation-log/`). That view rewrites each event for people, drops its `data`, and hides internal event types, models, budgets and raw errors. An event type or agent progress message without a rule there is hidden.
- Cloudflare logs are live operational logs from Workers and Containers. Use these when debugging deployment, service bindings, container boot, or unexpected runtime crashes.

Provider usage, cost, and repair diagnostics are internal operator telemetry.
They are not written to `job_events`, returned by customer generation APIs, or
rendered anywhere in the dashboard.

The queue consumer now admits one Cloudflare Workflow instance per job and acknowledges immediately. The Workflow invokes checkpointed agent-container stages, persists only sanitized semantic events into `job_events`, and stores opaque analysis, structure, and page-batch checkpoints under `_generation-checkpoints/{jobId}/` in R2. Lightweight heartbeat records stay in the transport layer and are never persisted.

## Container Runtime Gate

The agent-container image builds `@doxahq/agent` and executes its runtime preflight before the image can complete. Container startup executes the same real MDX compilation before creating or listening on the HTTP server. A missing validator artifact, Node runtime dependency, or broken MDX compiler therefore fails the image build or container process before any generation request can be accepted.

## Dashboard Events

During a real generation, the dashboard should advance through:

```txt
queued -> running -> workflow_started
container_stage_booted -> clone_started -> clone_complete
analysis_started -> analysis_progress -> analysis_complete
container_stage_booted -> clone_started -> clone_complete
structure_started -> structure_review_started -> structure_budget_applied -> structure_created
container_stage_booted -> clone_started -> clone_complete
writing_started -> page_write_completed -> pages_written
artifacts_published -> published
```

There is no total page cap. Every endpoint, SDK module and collection item gets
its page. The planner applies an editorial budget of 24 prose pages for
`fast-mvp` or 36 prose pages for `full-prod`. Collection and API-reference
pages do not count toward that budget. A reviewed structure with more editorial
pages than the budget fails with `structure_infeasible_constraints`. If
parseable review decisions exhaust their retries for other validation problems,
the structure stage emits `structure_review_degraded` and continues with the
best structurally usable candidate. Review output that is unparseable on every
attempt still fails.

Template-rendered pages (REST endpoint pages) are fixed by the API surface. The
planner and review prompts show one line for each endpoint group instead of
each page, and the review needs no decision for them. The worker writes them in
template groups of up to 500 pages (`MAX_TEMPLATE_WRITE_GROUP_PAGES`), with a
10-minute step timeout (`TEMPLATE_PAGE_BATCH_TIMEOUT_MS`) and no writer slot.
Model-written pages keep groups of `DOXA_WRITE_GROUP_SIZE` (24 by default) and
the `PAGE_BATCH_TIMEOUT_MS` timeout. The time check adds the waves of both
kinds.

The container emits an NDJSON heartbeat every 10 seconds. Every stage resets its liveness deadline for either a heartbeat or a semantic event. If neither arrives for 90 seconds, that Workflow step fails, destroys the active container request, and can retry from its last R2 checkpoint. Heartbeats do not consume database event sequences or appear in the dashboard.

Analysis, structure, writing, and finalization have independent deadlines in both queue-backed Workflow and local `container-inline` generation. The local coordinator replaces its active stage deadline when semantic stage events arrive; heartbeats reset only the idle deadline. A separate overall budget still applies while heartbeats remain healthy. Workflow retries never rerun an earlier completed checkpoint.

Each dashboard event includes:

- `sequence`: canonical per-job ordering from Postgres.
- `source`: `api`, `worker`, `container`, `agent`, or `system`.
- safe metadata such as `elapsedMs`, `model`, `generationProfile`, `pageConcurrency`, `editorialPageBudget`, `pageCount`, and current page/item.

## Cloudflare Tail

Tail the queue consumer:

```bash
pnpm --filter @doxahq/agent-worker exec wrangler tail doxa-agent-worker-production --format json
```

Tail the container wrapper:

```bash
pnpm --filter @doxahq/agent-container exec wrangler tail doxa-agent-container-production --format json
```

Logs are structured JSON. Filter by `jobId` when comparing logs with dashboard events.

Container logs include `sequence` as the container-local event sequence. Dashboard rows use the database `sequence`; use `data.containerSequence` to correlate a dashboard row back to the exact container log record.

## Generation Speed Knobs

Planning and writing use independently configurable models. Both defaults use
OpenRouter Nitro routing:

```bash
DOXA_PLANNER_MODEL=x-ai/grok-4.5:nitro
DOXA_WRITER_MODEL=openai/gpt-5.6-luna
DOXA_GENERATION_PROFILE=fast-mvp
DOXA_AGENT_PAGE_CONCURRENCY=6
GENERATION_IDLE_TIMEOUT_MS=90000
GENERATION_OVERALL_TIMEOUT_MS=10800000
ANALYSIS_STAGE_TIMEOUT_MS=2700000
STRUCTURE_STAGE_TIMEOUT_MS=1800000
PAGE_BATCH_TIMEOUT_MS=1800000
TEMPLATE_PAGE_BATCH_TIMEOUT_MS=600000
FINALIZATION_TIMEOUT_MS=600000
```

Analysis, structure generation, and structure review use
`DOXA_PLANNER_MODEL`. Page writing and targeted MDX repair use
`DOXA_WRITER_MODEL`. The API resolves this pair once and stores it on the job;
the Worker always executes the admitted values, so changing an environment
variable cannot change a running generation. `DOXA_AGENT_MODEL` remains only as
a compatibility fallback when neither role-specific variable is configured.

### Model provider

`DOXA_MODEL_PROVIDER` in the agent worker selects the model API: `openrouter`
(the default) or `anthropic`. The worker sends the provider and its key
(`OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY`) to the container, and the agent
picks the matching runtime in `packages/agent/src/core/providers`.

Model IDs are different for each provider. On OpenRouter the writer is
`anthropic/claude-haiku-5.5`; on Anthropic it is `claude-haiku-5-5`. When you
change the provider, change `DOXA_PLANNER_MODEL` and `DOXA_WRITER_MODEL` in both
`apps/api/wrangler.json` and `apps/agent-worker/wrangler.json`. A job keeps the
models that were admitted with it, so the worker stops a job with a clear
error when a model ID does not match the provider. Anthropic usage has no cost
field, so its requests count as `missingCostCount` in the usage summaries.

To add a provider, add its name to `MODEL_PROVIDERS` in
`packages/contracts/src/model-providers.ts`, add a runtime in
`packages/agent/src/core/providers`, and add its key setting in
`apps/agent-worker/src/model-provider.ts` and `scripts/dev-env.sh`.

`GENERATION_TIMEOUT_MS` is the legacy fallback when `GENERATION_OVERALL_TIMEOUT_MS` is absent. When the overall budget is configured, it takes precedence and enables the stage-aware local deadline behavior.

Page concurrency controls how many pages one container writes inside a checkpointed batch. Container `max_instances` and active Workflow capacity are both bounded at five. Increase concurrency only after measurements show spare model rate-limit and CPU capacity; it does not fix a Queue consumer wall-time limit and can make provider throttling worse.

The configured 120-page value is a hard cap on total output, including
reference inventory. It is independent of the 24-page `fast-mvp` and 36-page
`full-prod` editorial budgets. Crossing the total cap is an explicit infeasible
constraints failure, never a compaction or truncation signal.

## Internal Usage and Cost Logs

Each provider call is persisted with the job, stage, operation, exact model,
page, page retry, writer attempt, model iteration, tokens, provider cost, and
provider generation ID when available. Replayed stream or RPC delivery is
idempotent by `callId`; a real provider retry receives a new ID and is counted.
The model role is `writer` for the write stage and for `rest_extraction` calls
of the plan stage, which use the writer model, and `planner` for the others.

The Worker prints cumulative summaries after each stage and once at terminal
job completion:

```json
{"service":"doxa-agent-worker","eventType":"generation_usage_stage_summary","stage":"write","status":"completed","jobId":"...","requestCount":8,"promptTokens":12000,"completionTokens":6000,"totalTokens":18000,"cachedTokens":4000,"reasoningTokens":0,"missingCostCount":0,"costUsd":"0.1834"}
{"service":"doxa-agent-worker","eventType":"generation_usage_summary","status":"completed","jobId":"...","requestCount":11,"promptTokens":18000,"completionTokens":7500,"totalTokens":25500,"cachedTokens":4000,"reasoningTokens":1800,"missingCostCount":0,"costUsd":"0.4271"}
```

These summaries are cumulative for the job. If `missingCostCount` is non-zero,
the shown cost is only the sum of provider-reported costs and is incomplete;
Doxa does not estimate missing prices.

## Repair Diagnostics and Retention

A located MDX parser failure is repaired before the full-page retry path. Doxa
allows three bounded writer-model patches against the same immutable failed
draft. Every patch is checked against that draft's hash and exact parser
location, and the complete page is revalidated before it is accepted. Rejected
JSON, unsafe patch bounds, and remaining validation issues are sent back as
focused feedback for the next patch attempt. Exhausting all three patches
activates the existing single outer page retry, which generates one fresh draft
and receives its own isolated three-patch repair budget.

Failed drafts are written to the private
`_generation-diagnostics/{jobId}/{diagnosticId}.mdx` R2 prefix and capped at
256 KiB. Structured diagnostic rows retain the parser rule, message, line,
column, snippet, hash, model, outer page retry, writer attempt, targeted repair
attempt, maximum repair attempts, rejection reason, validation issue codes, and
repair outcome. Provider usage records with `operation=mdx_repair` identify the
token and cost impact of each actual model patch request.

Repair diagnostics and cost records are operator-only telemetry. They are not
written to customer generation events or displayed in the dashboard.

Retention windows are:

- failed R2 drafts: 30 days, by the R2 lifecycle rule `doxa-generation-diagnostics-expiry`;
- structured repair diagnostics: 30 days;
- provider usage and cost records: kept until billing decides their retention.

The existing Worker cron removes expired diagnostic rows in bounded batches. It never deletes a usage row. The lifecycle rule and its install command are in [Storage Garbage Collection](current/storage-garbage-collection.md#r2-lifecycle-rules).

## Generation Control

The admin page `/admin/generation` and its API routes were removed on
2026-10-23. The pause flag stays. The API and the generation Worker read it
from the `platform_generation_controls` row with the id `global`:

- A new generation start gets the answer 409.
- The Worker cancels a queued job before it runs.

To pause new generation jobs, set the flag with SQL:

```sql
INSERT INTO platform_generation_controls (id, status, reason, updated_at)
VALUES ('global', 'paused', '<reason>', now())
ON CONFLICT (id) DO UPDATE
SET status = 'paused', reason = EXCLUDED.reason, updated_at = now();
```

To resume, set `status = 'enabled'` and `reason = NULL` on the same row.

To cancel one job, use the cancel action of the project generation page.

For a hard infrastructure stop, run:

```bash
pnpm --filter @doxahq/agent-worker exec wrangler queues pause-delivery doxa-generation-jobs
pnpm --filter @doxahq/agent-container exec wrangler containers list
pnpm --filter @doxahq/agent-container exec wrangler containers instances <CONTAINER_ID>
pnpm --filter @doxahq/agent-container exec wrangler containers delete <CONTAINER_ID>
```

## Safety

GitHub installation tokens and OpenRouter keys must never appear in job events or logs. If a provider or clone error includes one, the generation coordinator and container logger redact it before persistence or output.
