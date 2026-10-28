# Production Docs Pre-rendering

## Purpose

Doxa can save public production HTML and route data when publication occurs. The dispatcher serves this output before it starts a live renderer.

This feature does not change previews or permanent generation URLs. These routes keep their current access rules and rendering paths.

## Delivery Flow

For an eligible HTML request, the dispatcher resolves the hostname first. It then builds the expected render identity from trusted resolution data.

The dispatcher reads a complete manifest and then the object for the requested representation only. It uses live rendering if the saved output is missing or invalid.

An HTML request reads the HTML object. A route-data request reads the JSON object. A saved redirect needs no object read, because the manifest entry carries its target and status.

The gateway sends one security header set for saved output and for live output. A visitor never receives weaker headers because the saved output was missing.

Client navigation uses `/_doxa/route-data/v1`. This endpoint returns saved route data or prepares the same public data contract live.

The endpoint also works without pre-rendering. The lazy route-data cache (`DOXA_PROD_ROUTE_DATA_CACHE_MODE`) stores live route data in `DocsRouteDataCache` on first request. If both rollouts include a site, saved output has priority. See [production-docs-caching.md](./production-docs-caching.md).

The public gateway always returns `Cache-Control: private, no-store`. The internal Worker entrypoints cache valid immutable output for 1 year.

Missing saved output uses a 30-second internal fallback TTL. This limit lets repaired output replace the live fallback quickly.

## Publication Flow

Production pointer changes and pre-render task intents use one database transaction. Cache invalidation intent uses the same transaction.

The API attempts immediate dispatch after the transaction commits. A dispatch failure leaves the task in the database for scheduled retry.

The API scheduler runs every five minutes. It dispatches due tasks, reclaims expired leases, and creates missing current-release tasks.

The scheduler also checks a bounded set of completed manifests. It reopens a task when its current manifest is missing or invalid.

The pre-render Workflow writes HTML and JSON objects first. It writes the complete manifest last with a conditional R2 operation.

Rendering never changes the production pointer. A failed render keeps the live renderer available for the published version.

## Release Identity

The deployment script computes one renderer release ID from these values:

- The immutable server package digest.
- The client asset manifest digest: the content-hashed files under `dist/client/assets`.
- The output schema version.

The generated API, dispatcher, and pre-render Worker configurations must contain the same release ID. The deployment script rejects a mismatch.

## Feature Settings

`DOXA_PROD_PRERENDER_MODE` accepts `off`, `allowlist`, or `all`. An invalid value disables pre-rendering.

`DOXA_PROD_PRERENDER_SITE_IDS` contains the site IDs for allowlist mode. It has no effect in `off` or `all` mode.

`DOXA_PRERENDER_REPAIR_ENABLED` controls request-time repair submissions. Scheduled reconciliation stays active when this setting is false.

Each Worker isolate submits at most one repair for one render in 60 seconds. The API keeps its own cooldown, which stays correct across isolates.

Dynamic Worker selection stays independent. Saved output can work while Dynamic Workers are disabled.

## Required Cloudflare Resources

Create the private `doxa-docs-rendered-html` R2 bucket before the first deployment. Do not enable public bucket access or an R2 custom domain.

The private `doxa-docs-prerenderer-production` Worker has no route, preview URL, or `workers.dev` URL. It owns the Workflow and R2 write binding.

The dispatcher binds the derived-output bucket for reads. It has no code path that writes or deletes an object. Cloudflare R2 bindings carry no read-only mode, so this boundary is a code rule, not a platform rule.

The API uses the `PrerenderQueue` service binding. The Workflow uses narrow renderer and task service bindings.

The pre-render Worker is the only Worker that writes or deletes objects in the derived-output bucket.

## Rollout Procedure

1. Apply migrations `0022_docs_prerender_tasks.sql` and `0023_storage_gc_entries.sql` with the normal migration process.
2. Create the private `doxa-docs-rendered-html` R2 bucket.
3. Run `pnpm deploy:docs-template -- --dry-run`.
4. Make sure that all generated configurations use one release ID.
5. Deploy with pre-render mode `off`.
6. Set an allowlist with one production site.
7. Enable request repair for that site.
8. Compare saved hits, forced misses, and live fallback behavior.
9. Use `all` only after the allowlist checks pass.

The deployment does not wait for output generation. Scheduled reconciliation creates current-release work after a normal deployment.

## Storage Lifetime

Saved output is deleted when it stops serving production. The scheduled garbage collector owns that work. See [storage-garbage-collection.md](./storage-garbage-collection.md).

A pre-render task becomes obsolete when the published version changes, when the hostname stops serving the site, or when the renderer release changes. The obsolete task records its render as collectable.

The objects wait 25 hours before deletion (`HOSTNAME_READER_GRACE_SECONDS`). The dispatcher can hold a resolved hostname for one day, so this grace period covers a request that still asks for the previous render.

The collector recomputes the current render identity for every active hostname of the site before it deletes an object. A render that still serves production is kept.

A rollback to an earlier version revives the pre-render task for that identity, and the collector then keeps the objects.

## Rollback

Set `DOXA_PROD_PRERENDER_MODE=off` and deploy the rendering services. This setting bypasses saved HTML and route data without a cache purge.

Leave the task table and R2 objects in place during rollback. The live renderer remains the normal fallback path.

## Logs and Alerts

Operational errors are present when `DEBUG=false`. Detailed request timings appear only when `DEBUG=true`.

Worker Observability stores the structured logs. The source configurations use full log sampling for the new private Worker.

Log retention follows the active Cloudflare account plan. Make sure that the retention period meets the incident-response requirement before rollout.

For longer retention, configure Logpush to approved storage. This repository does not create that external destination.

Create an alert for this filter:

```text
event = "docs_prerender_task_health" AND status = "degraded"
```

Also alert on these event values:

- `docs_prerender_repair_enqueue_failed`
- `docs_prerender_dispatch_failed`
- `docs_prerender_manifest_inspection_failed`

The alert destination is an external rollout requirement. The repository does not claim that an alert destination is active.

## Manual Retry

Use this procedure for a known public production route:

1. Make sure that request repair is enabled.
2. Request the affected route once.
3. Wait for the API task claim or the next scheduled run.
4. Find the task by its render ID.
5. Make sure that the task reaches `succeeded`.
6. Request the route again after the 30-second fallback cache expires.

Do not trigger a Workflow with a browser-provided object key or package reference. The API must create and claim the task.

## Local Verification

Local development keeps the existing `.localhost` domains. No DNS proxy is necessary.

The dispatcher fixture covers saved HTML, saved route data, forced misses, live fallback, repair failure, and forged render hints.

Run the fixture with this command:

```bash
pnpm --filter @doxahq/docs-dispatcher test -- prerender-dispatch
```

Cloudflare Workflow scheduling and service-binding deployment need the Cloudflare runtime. The deterministic local tests cover their adapters and state transitions.

## Freshness and Security

The dispatcher resolves the hostname before every saved-output lookup path. A browser-provided render ID is only a consistency hint.

The dispatcher never builds an R2 key from a client-provided site ID, artifact path, or object name. It uses the trusted host resolution.

Saved output only serves public production documentation. Private, preview, unknown, and resolver-failure requests do not use this bucket.

The API reads the production access policy from one shared helper. If production documentation ever becomes gated, task creation, repair, and dispatch stop instead of writing gated pages to this bucket.

The public route-data contract rejects raw-HTML properties, event-handler properties, and unsafe URL properties. The MDX parser cannot produce them, and the stored contract stays as narrow as its producer.

Public hostname invalidation keeps the limits in [production-docs-caching.md](./production-docs-caching.md). This feature does not add instant revocation.

Do not use this public cache design for private documentation.
