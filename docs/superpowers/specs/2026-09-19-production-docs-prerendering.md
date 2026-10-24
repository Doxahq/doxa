# Production docs pre-rendering: HTML and route data

Status: final implementation handoff, not implemented.
Date: 2026-09-19.
Decision: Option 3, Doxa-owned route-data artifacts.

This document replaces the earlier conversational specs. Where they conflict, use this document.

## 1. Goal and authorized scope

Generate complete HTML and the data needed for client navigation when public production documentation is published. Serve those saved results through the docs dispatcher. Automatically use the existing renderer when saved output is missing, invalid, or temporarily unavailable.

The completed feature includes BOTH HTML requests and client-side navigation. An HTML-only milestone is useful during development, but does not complete this spec.

Implement without subagents or delegated development. Follow the project's clean-code skill at `/Users/islemmaboud/.agents/skills/i-coderone-clean-code/SKILL.md` and applicable repository instructions.

This handoff describes implementation work. It does not authorize a commit, deployment, live migration, secret change, or remote resource creation. Prepare required configuration and migration artifacts within the implementing task's authorization. Follow repository approval boundaries for restricted changes.

### In scope

- Public production docs on generated and verified custom hostnames.
- Saved HTML and saved public route data from one pinned content snapshot.
- Workers Cache in front of R2 output.
- Dynamic Worker fallback and the existing safe shared-renderer fallback.
- Durable publication tasks, retries, bounded repairs, and operational logs.
- Production-only integration with existing TanStack loaders.
- Local fixtures and tests for both saved and live paths.
- Deployment wiring for required services and bindings, subject to repository approval rules.

### Explicit exclusions

- NO change to previews or permanent-generation URLs: routing, access policy, caching, renderer selection, and fallback remain as-is.
- NO preview renderer flags or migration to Dynamic Workers.
- NO candidate-release tracking, deployment backfill gates, dual-release rendering, or readiness cutover system.
- NO old-browser-tab compatibility infrastructure or multi-release asset retention system.
- NO team/member model or changes to private-preview authentication.
- NO automatic change to canonical-domain policy or custom-domain selection.
- NO switch to full-document navigation for ordinary docs links.
- NO TanStack Static Server Functions middleware, fork, or generic function-result cache.
- NO pre-rendering chat, search APIs, raw Markdown, playground responses, or arbitrary server functions.
- NO guarantee of zero failures, a Lighthouse score of 100, or global immediate consistency.

## 2. Repository facts and integration points

Reverify these paths against the checkout before implementation. Existing unrelated work belongs to the user.

| Area | Existing location and behavior |
| --- | --- |
| Public dispatcher | `apps/docs-dispatcher/src/index.ts`: `DocsHostCache`, `DocsHtmlCache`, scoped content binding, Dynamic Worker loading |
| Safe rendering fallback | `apps/docs-dispatcher/src/dispatcher.ts`: GET/HEAD Dynamic exceptions or 5xx can use the shared renderer |
| Cache policy | `apps/docs-dispatcher/src/cache-policy.ts`: public production eligibility, trusted hostname/version props, uncached public gateway |
| Host resolver | Private resolver client in `packages/contracts/docs-resolver`; platform mappings establish tenant and source identity |
| Content runtime | `apps/docs-runtime/src/runtime-source.ts`: pinned artifact validation and one-shot `getRouteData` |
| Public renderer | `apps/docs-template/src/server.ts`: guards then TanStack rendering |
| Prepared route data | `apps/docs-template/src/runtime/docs-route-data.ts`: page metadata, navigation, parsed/highlighted MDX |
| Live loader transport | `apps/docs-template/src/runtime/runtime-route-data.ts`: `loadDocsRouteData` and `loadDocsRootRouteData` |
| Route consumers | `apps/docs-template/src/routes/$.tsx`, `index.tsx`, and `lib/docs-page-route.ts` |
| Structured document format | `packages/mdx-runtime/src/types.ts`: public data nodes, not executable components |
| Generation completion | `apps/agent-worker/src/generation-workflow-runtime.ts`; API repository `publishJob` and `completeJob` |
| Promotion | `apps/api/src/repositories/jobs.ts`: a new DB version can reuse an existing artifact prefix |
| Editor publication | `apps/api/src/repositories/docs-content.ts` |
| Durable purge precedent | API docs-cache invalidation repository/service and scheduled processing |
| Renderer packaging | `apps/docs-template/scripts/deploy-renderer.mjs` and its imported helpers |
| Cache constraints | `docs/current/production-docs-caching.md` |

`apps/docs-template` must not import platform repositories or storage clients. `apps/docs-runtime` must not become the public HTML renderer. Preserve the one-shot content-data path.

## 3. Request flows

### Initial document

```text
Browser GET /guide
  -> trusted hostname resolution and public-production eligibility
  -> versioned internal HTML cache
      hit -> saved response
      miss -> validated R2 render manifest and HTML
          unavailable/invalid -> pinned Dynamic Worker SSR
              exception/5xx before response commitment -> existing shared SSR fallback
  -> public response with the current no-store boundary
```

### Client navigation

```text
TanStack loader for /guide
  -> production route-data adapter
  -> same-origin GET /_doxa/route-data/v1?path=%2Fguide&render=<opaque-render-id>
  -> trusted hostname resolution and public-production eligibility
  -> versioned internal route-data cache
      miss -> validated saved route-data JSON
          unavailable/invalid -> live preparation of the same public data contract
  -> TanStack performs its existing page, redirect, and not-found behavior
```

The data endpoint must never return HTML as a successful JSON response. Live route-data preparation is different from full-document SSR.

### Publication

```text
Persist source artifacts
  -> commit production pointer + durable render intent in one DB transaction
  -> existing hostname invalidation
  -> attempt immediate task dispatch after commit
  -> private pre-render Workflow prepares HTML and JSON
  -> write complete manifest last
  -> durable task completion
```

A rendering failure must not reverse successful publication. SSR serves the new version while work retries. Rendering completion NEVER advances or restores a production pointer.

## 4. Module boundaries and clean-code requirements

Use focused modules with typed dependencies. Do not turn the dispatcher or API entrypoint into a rendering/task manager monolith.

| Owner | Responsibility |
| --- | --- |
| Browser-safe renderer contract | Versioned public route-data schemas, discriminated result unions, pure validation helpers |
| Template | Prepare a route, render prepared data, consume saved/live data through a small loader adapter |
| Docs runtime | Validate exact source artifacts and produce the complete route plan/content data |
| Dispatcher | Resolve hosts, enforce eligibility, construct storage identity, read validated output, apply caches, select fallback |
| Private pre-render Worker | Run durable rendering steps with scoped content and write derived objects |
| API | Own task DB transactions, claims, retries, reconciliation, and internal completion callbacks |

Place renderer-neutral schemas in a focused browser-safe package/subpath consistent with existing workspace exports. Reuse MDX node definitions. Do not duplicate the public loader DTO in three applications. Keep DB contracts and renderer-only types out of browser imports.

Required standards:

- No new `any`, broad catch-all interfaces, or assertions that conceal invalid data.
- Accept external input as `unknown` and validate with strict schemas and explicit limits.
- Infer shared types from schemas where practical.
- Use discriminated unions for lookup results, task results, route states, and endpoint responses.
- Inject storage, clocks, renderer calls, and task dispatch into testable units.
- Separate identity, routing, storage validation, cache policy, rendering, and orchestration.
- Reuse page preparation for saved data, saved HTML, and live fallback.
- Do not build a generic storage/plugin abstraction for hypothetical providers.

## 5. Immutable source and render identity

Compute identities from canonical, schema-versioned JSON with stable key order. Do not hash arbitrary serialization or concatenate unescaped values.

```text
artifactIdentity = sha256({ schemaVersion, siteId, artifactPrefix, sourceManifestPath })
rendererReleaseId = sha256({ serverPackageDigest, clientAssetManifestDigest, outputSchemaVersion })
renderContextId = sha256({ trustedRequestOrigin, effectivePublicOutputConfiguration })
renderId = sha256({ schemaVersion, siteId, artifactIdentity, rendererReleaseId, renderContextId })
```

Requirements:

- Artifact paths must match the source manifest's site and artifact identity.
- A promoted DB version can reuse a source artifact. Do not require its new DB ID to equal the source manifest version ID.
- The server code package digest includes applicable compatibility configuration.
- The public output configuration includes all output-affecting settings not already immutable in the source or renderer release.
- No secrets or private configuration are serialized into render context or browser payloads.
- Browser-visible `renderId` is a consistency hint, NEVER authority to read an object.
- The dispatcher constructs expected keys from trusted resolution. It never uses a client-supplied R2 prefix.

### Host-dependent output

Preserve existing canonical URLs, Open Graph metadata, relative links, and hydration behavior. Do not introduce a new SEO policy.

For v1, scope derived output by the validated request origin. Pre-render the generated hostname and each active public custom hostname separately. This is intentional duplication that avoids assuming all serialized output is host-independent. Domain activation enqueues the current artifact for that hostname. Missing hostname variants use SSR.

Canonical configuration remains whatever the renderer currently uses. Request origin and canonical origin are different concepts. Reject forwarded-host overrides from visitors.

Cross-host deduplication is outside this implementation. Promotion can still reuse output for the same artifact, release, and hostname context.

## 6. Public data contract

Define `PublicDocsRouteDataV1` from the current `DocsRouteData`/`DocsRootRouteData` shapes. It covers:

- Page data, including prepared MDX nodes, navigation, metadata, and feature configuration.
- Existing redirect results with validated local targets.
- Existing not-found results.
- Existing empty-site behavior.

Use only JSON-safe values. Validate finite numbers, optional-field handling, node names, props, tree depth, total node count, strings, arrays, and total encoded size. Round-trip tests must cover every supported MDX component representation.

Do not serialize request context, service bindings, credentials, arbitrary exception objects, server middleware context, or React elements. Stored parse errors are not valid page output.

Do not bypass MDX safety checks because input was previously generated. Restrict URL schemes and component props through the existing allowlists and extend tests where required. Never restore a parsed node as executable JavaScript.

Example conceptual endpoint result:

```ts
type PublicRouteDataResponse =
  | { status: "ok"; schemaVersion: 1; renderId: string; data: PublicDocsRouteDataV1 }
  | { status: "version_mismatch" }
  | { status: "unavailable"; retryable: boolean };
```

Use 200 for valid data, including typed router outcomes; 409 for version mismatch; 503 for exhausted live fallback. Use generic 404 for unknown/ineligible hosts. Use 400 for invalid input and 405 for unsupported methods. Do not expose whether another project's object exists.

## 7. Storage and commit protocol

Use a private derived-output R2 bucket, proposed name `doxa-docs-rendered-html`. It stores both HTML and route data. Keep public `r2.dev` and custom-domain access disabled. Source artifacts remain in their existing bucket.

```text
render/v1/sites/{siteId}/renders/{renderId}/
  objects/{sha256-of-bytes}.html
  objects/{sha256-of-bytes}.json
  manifest.json
```

A strict manifest includes schema version, full validated render identity, source artifact version, release, host context, completion timestamp, and sorted route entries.

Each renderable page entry includes normalized pathname plus HTML and data references. Each reference contains digest, byte length, content type, and derived relative object name. Redirect entries contain validated relative targets and route-data references. Use a typed array or safe map; reject duplicate paths and prototype-related property hazards.

The complete route plan must be represented. Routes that cannot fit the static limits can have an explicit `live_only` entry and a bounded reason code. Such entries must not trigger repair on every visit. Do not mark corrupt or partially written output as `live_only` to hide a failure.

Commit protocol:

1. Acquire one active task lease for the render identity.
2. Validate source and renderer package.
3. Produce the complete route plan.
4. Prepare each page once and render HTML using that same prepared data.
5. Fully consume and validate the HTML response. Detect renderer errors, not just HTTP 200.
6. Serialize and validate the public data.
7. Write content-addressed objects with checksum verification.
8. Confirm referenced object identities and sizes.
9. Write the complete manifest last with a conditional operation.
10. Mark the task complete through its current claim token.

There must be no public ready manifest for a partial set. R2 consistency does not replace claim fencing or conditional manifest updates.

### Repair

- Reuse valid objects and complete manifests.
- Recreate missing objects.
- Replace proven corrupt output only conditionally against the observed object/manifest version.
- A stale writer must not replace a manifest written by another attempt.
- A stale task callback must not complete a newer claim.
- Ordinary repeated rendering does not overwrite a valid manifest.
- Byte differences alone do not prove corruption: framework output can contain generated identifiers. Validate semantics and pinned identity rather than requiring every rerender to have identical bytes.
- Keep related HTML and JSON from the same prepared snapshot. Audit dates and other ambient values; capture any necessary render-time value for the attempt instead of reading changing state per route.
- Cleanup must never delete objects referenced by a live manifest or active task. Do not introduce broad bucket lifecycle deletion as part of this work.

## 8. Private pre-render execution

Add a private `apps/docs-prerenderer` Worker with a Workflow and narrow service-binding entrypoints. No public routes, public preview URLs, or `workers.dev` access.

The outer Worker can access derived-output storage and the approved renderer package. The loaded renderer gets only scoped content and public configuration. Keep its global outbound access disabled. It gets no DB, GitHub, tokens, general storage, task-management, or invalidation binding.

Task input comes from trusted API dispatch. Resolve renderer package references against server-owned release configuration. Never execute a module URL or package key from a browser request.

Add a platform-neutral private renderer operation for preparing public route data and rendering that prepared data. Prefer a named private entrypoint or scoped invocation context. Do not add a publicly reachable “render arbitrary artifact” route. Use the exact installed TanStack server handler and hydration machinery; do not construct a second HTML renderer.

Add a private runtime `getPrerenderPlan` operation. It enumerates pages and root/section redirects from the pinned source manifest and navigation. Do not crawl arbitrary links or fetch external resources. Detect redirect loops and targets outside the allowed local route set.

Keep bodies in R2 rather than Workflow step return values. Checkpoints contain small references and progress only. Use bounded batches and CPU, byte, route-count, and wall-time limits. Start with four concurrent routes and tune with measurements.

## 9. Dispatcher HTML path

Preserve existing public-production HTML eligibility. Do not broaden query, cookie, authorization, raw Markdown, or internal-path eligibility as a side effect.

Add `readPrerenderedHtml()` inside the eligible internal HTML cache fill. Its result is a typed hit, miss, live-only, invalid, or unavailable value.

The reader must:

- Build the exact expected render identity from trusted host resolution and active renderer configuration.
- Validate manifest identity, schema, size, route entry, object prefix, metadata, and checksum.
- Fully read bounded HTML before sending it to the browser, so read or digest failure can fall back safely.
- Return correct content type and current security headers. Never replay arbitrary stored response headers.
- Return no body for HEAD. Do not let HEAD populate an empty cached GET response.
- Cache only valid HTML or explicitly validated local redirect responses.
- Use current response security policy; never reuse a request-specific CSP nonce.

On pre-render failure, use existing pinned Dynamic SSR. Existing safe shared SSR remains the last fallback. Shared fallback can re-resolve the hostname, so keep it outside the original pinned version's cache unless a separately tested pinned contract exists.

Fallback is guaranteed only before response commitment. An SSR body failure after bytes reach the browser cannot be replaced by another response. Log it; do not claim transparent recovery.

## 10. Route-data endpoint and loader integration

Reserve `/_doxa/route-data/v1` in the dispatcher for this feature. This is a dedicated JSON path, not a relaxation of HTML cache eligibility.

Accept only GET/HEAD with one normalized `path` and optional opaque `render` hint. Reject duplicates, unknown query fields, excessive lengths, malformed encoding, control characters, backslashes, traversal, absolute URLs, internal paths, and ambiguous encoded separators. Reuse route normalization rules and prove equivalence with the renderer. Do not silently collapse valid distinct routes.

Require same-origin browser use. Do not enable permissive CORS. Do not rely on Origin or Fetch Metadata as authorization. Resolve the actual hostname and require public production before serving data, even if the client supplies a plausible render ID.

The dedicated internal JSON cache key must include trusted hostname, full pinned resolution, renderer release, render context, normalized page path, schema version, and feature mode. Client headers must not influence a shared fill.

Requests with cookies or Authorization never use the shared JSON cache. The normal client adapter fetches with credentials omitted because this endpoint serves public production data only. Ineligible requests use the existing authorized live loader path. Denials and auth errors must never trigger an alternate path that bypasses authorization.

On saved-data failure, prepare the same DTO live for the pinned version. Prefer an internal renderer data operation. It reuses `resolveDocsRouteData` and its one-shot content request. It does not render HTML and extract JSON from the document.

The browser-facing adapter must:

- Be enabled only by a server-established public-production capability in the initial page context. Browser state is a hint; the endpoint independently verifies eligibility.
- Use existing SSR loaders on the server and on preview/permanent-generation routes.
- Preserve hydration data, preload behavior, route cancellation, redirects, not-found results, and existing `requireDocsPageData` handling.
- Use an AbortSignal. Cancellation is not a repair failure and must not start a second request.
- Validate status, content type, schema, render identity, and payload limits before returning data.
- Fall back to the original live server function once when the endpoint is disabled or temporarily unavailable and doing so preserves access rules.
- For an enabled production adapter, the live-function fallback must also return or validate its render identity. Do not accept a newer artifact silently after a failed saved-data request. Use the same version-mismatch behavior. Preserve the existing preview function contract through a production-only wrapper where required.
- Never loop between the JSON endpoint and live function. The live fallback must explicitly bypass saved-data lookup.
- Never execute an error payload or treat an HTML login/error page as JSON.

Store the opaque render identity in public page context for both saved and live production HTML. If content changes between the document and a later navigation, return 409. For a user navigation, perform at most one normal document navigation to the destination. A speculative preload must not reload the tab. If mismatch persists, show the existing recoverable error UI. Do not add old-release routing or old-tab compatibility machinery.

Client router caches currently use infinite stale time. Scope cached data to the current document/render identity; do not claim an open document automatically refreshes after publication.

## 11. Feature flags and cache behavior

Proposed flags:

```text
DOXA_PROD_PRERENDER_MODE=off|allowlist|all
DOXA_PROD_PRERENDER_SITE_IDS=
DOXA_PRERENDER_REPAIR_ENABLED=true|false
```

Invalid values fail closed to off and produce a configuration warning. The mode controls both HTML and route data. Build the endpoint and adapter so off mode returns to the existing live loader without navigation failures.

Keep Dynamic Worker selection independently configurable. Pre-render selection must not accidentally depend on `DOXA_PROD_DYNAMIC_RENDERER_MODE`. With pre-render enabled and Dynamic mode off, stored output can serve; missing output uses the existing shared production renderer.

Include mode and release identity in internal cache props. Turning the feature off must bypass saved output even when an old internal cache entry exists. No cache-purge-dependent switch-off guarantee.

Use existing 24-hour internal caching for valid immutable output. Keep all public HTML and JSON gateway responses no-store, including errors. Do not introduce browser caching of mutable hostname URLs.

Successful live fallback caused by missing/failed pre-rendering gets a short internal TTL, initially 30 seconds. This avoids hiding repaired output for 24 hours. A manifest cache miss must expire within 30 seconds too. Do not cache 5xx, auth failures, corrupt data, or unknown hosts.

## 12. Tasks, retries, and reconciliation

Add a dedicated render-task table through the existing migration process. The API owns DB access; the pre-render Worker reports through typed internal methods.

Required task fields: ID, site ID, artifact identity/paths, trusted hostname context, renderer release and context identity, reason, status, attempt count, next-attempt time, claim token, lease deadline, heartbeat time, last error code/message, creation/update/completion times.

Unique logical task: site + artifact + renderer release + render context. Duplicate scheduling must not reset a running lease or erase a permanent failure. A deliberate repair can reopen a completed task after a cooldown with a new attempt token.

Statuses: pending, running, succeeded, failed, obsolete. Distinguish dispatch accepted from completed. Workflow IDs include logical task plus attempt identity. API timeouts after successful dispatch must not create unbounded duplicate Workflows.

Use expiring leases, periodic progress heartbeats, and fenced updates. Use bounded exponential backoff with jitter. Initial policy: eight attempts, delay starting at 30 seconds and capped at 15 minutes. Exhaustion becomes an actionable failed task. Classify invalid input and unsupported output as permanent failures rather than retrying forever.

Persist intent beside every production pointer mutation, including generation, promotion, editor publication, and starter publication. Find all callers; do not rely on the example paths alone. Preserve existing transaction locks, baseline checks, and cancellation handling.

A domain added after publication also needs a task for its current production context. No re-render is required merely because a promoted DB clone points to the same artifact and context.

A render task never revives a deleted site, disabled hostname, cancelled generation, or obsolete publication. Revalidate task eligibility through the API before starting expensive work. Deletion and obsolete-task cleanup follow existing lifecycle policy; retaining a string site identifier must not authorize rendering a removed tenant.

The API scheduler does two bounded jobs:

1. Dispatch pending work and reclaim expired leases.
2. Reconcile currently published public render identities against task/manifests, including failed request-time enqueue attempts.

Reconciliation must run without traffic and use pagination/cursors. This is routine recovery, not a deployment backfill gate. It may opportunistically create missing output after a normal renderer deployment; deployment never waits for it.

## 13. Repair abuse limits and observability

Only repair a known expected route, a missing complete set, or an invalid expected object. An unknown path absent from a valid plan does not create work. `live_only` entries do not create repeated repairs.

Deduplicate by trusted render identity, with a per-identity cooldown and bounded per-site/global task concurrency. A visitor cannot request another release, choose a package, increase route count, or cause arbitrary rendering.

Request-time enqueue uses caught background work. It does not block the response. Reconciliation provides durability if the background submission never completes.

Required structured event: `docs_prerender_repair_enqueue_failed`.

Include request/trace ID, site ID, hostname, render identity, expected route identifier, bounded reason code, error class, sanitized error message, and task ID when known. Emit operational errors even with DEBUG=false. Do not log tokens, cookies, private content, request bodies, or arbitrary headers.

Add counters for lookup outcomes, repair submission failures, retries/exhaustion, fallback outcomes, and oldest task age. Avoid high-cardinality metric labels; detailed identities belong in logs.

Document retained error-log storage, sampling policy, retention, alert query, and manual retry procedure. If external alert routing needs user configuration, list that as a rollout requirement rather than claiming it is active.

Capture repeated enqueue failure, task retry exhaustion, corrupt output, and sustained shared fallback. DEBUG controls detailed timings only.

Suggested debug timings: `doxa_prerender_manifest`, `doxa_prerender_object`, `doxa_route_data`, and fallback reason. Do not persist build-time Server-Timing values and present them as current request duration.

Response diagnostics distinguish representation source (`prerender`, `dynamic`, `shared`) from edge cache status. A cached historical fill header must not be presented as proof that the renderer ran on the current request. Preserve existing renderer-mode consumers and update tests deliberately.

## 14. Security boundaries and limits

### Tenant isolation

- Always resolve hostname before storage access.
- Never accept authority from a supplied site ID, render ID, object key, forwarded host, or artifact path.
- Parse R2 manifests as untrusted structured data. Enforce expected namespace even after schema validation.
- Preserve runtime source-manifest validation and promoted-artifact compatibility.
- Keep the bucket private and all mutation/render endpoints service-binding-only.
- An R2 binding permits more than a TypeScript read-only interface can enforce. Give the dispatcher only the derived-output bucket, never a renderer-code write API. Keep write operations confined to the private pre-render service in code; do not claim that a narrowed TypeScript type is an infrastructure permission boundary.
- Do not place executable customer code in renderer packages. Existing MDX component allowlists remain in force.

### Access freshness

The existing public hostname cache has delayed invalidation limits documented in `docs/current/production-docs-caching.md`. Reuse its durable purge path for publication and domain changes. Do not extend TTLs, bypass resolution on hits, or introduce stale-on-resolver-error serving.

This work does not make public cached content instantly revocable. Preserve the documented public freshness model and explicitly describe it in rollout notes. Never use that model for private documents. Private resolution, unknown resolution, or resolver failure must not serve saved HTML/JSON merely because an object exists.

### Resource bounds

Centralize limits with typed defaults and tests. Initial values:

| Limit | Initial value |
| --- | --- |
| Concurrent render routes per task | 4 |
| HTML bytes per saved route | 2 MiB |
| JSON bytes per saved route | 2 MiB |
| Manifest bytes | 2 MiB |
| Manifest routes | 2,000 |
| Decoded pathname length | 2,048 characters |
| JSON/node nesting depth | 64 |
| Stored lookup deadline | 1,500 ms total |
| Live fallback internal cache TTL | 30 seconds |
| Repair cooldown per render identity | 60 seconds |

These are initial engineering limits, not measured performance claims. Align route-count limits with the existing product cap if it is lower. Add total node/string/array limits consistent with the byte and depth limits. Review memory use at configured concurrency.

Read bodies with a byte counter; do not rely only on Content-Length. Deadline expiry ignores late results and cancels supported operations. Do not leak unhandled rejections or assume Promise.race cancels underlying work.

If a valid route exceeds static limits, keep live behavior and record a live-only reason. If it exceeds existing safe live limits too, use the normal error boundary. Do not truncate documentation silently.

## 15. Deployment and local development

Prepare required service/bucket bindings, renderer release digest generation, task migration, local fixtures, and validation scripts. Apply restricted configuration changes only under the implementing task's approvals.

Normal deployment remains normal deployment. No pre-render migration of every site, no readiness gate, no candidate release, and no deployment wait for generated output. Missing current-release output uses live rendering and normal reconciliation.

The active output identity must match the deployed server package and client assets. Serving HTML from a different release to avoid a miss is forbidden. No old-tab compatibility guarantee is added.

Local development remains on the existing `.localhost` setup. Do not add DNS proxying. Include an isolated local fixture that exercises saved HTML/data and forced misses. If a Cloudflare feature cannot run locally, test the adapter deterministically and state which integration remains unverified.

## 16. Failure behavior

| Condition | Response behavior | Recovery |
| --- | --- | --- |
| Missing manifest | Live renderer/data | Deduplicated render task |
| Expected object missing or invalid | Live renderer/data | Log and repair |
| Unknown path in valid plan | Existing live not-found behavior | No rebuild |
| Explicit live-only route | Existing live path | No repeated repair |
| R2 exception or lookup deadline | Live renderer/data | Log; bounded recovery |
| Wrong tenant/context/release manifest | Never serve it; live fallback if authorized | Security/error event and repair |
| Resolver unavailable | No saved response | Existing permitted error/fallback policy |
| Private/preview/snapshot request | Existing rendering path | No pre-render task |
| Dynamic HTML exception/5xx before commitment | Existing safe shared fallback | Operational event |
| Live JSON preparation fails | Typed non-cacheable error; bounded original-loader fallback | Operational event |
| Browser abort | Stop navigation work | No repair solely for abort |
| Repair enqueue fails | Current live response continues | Persistent error log + reconciliation |
| Task retries exhausted | Live path continues | Failed task + actionable alert |
| Version changes during navigation | 409; one document navigation on user action | No reload during prefetch |
| Publication changes during render | Old output cannot advance current pointer | Obsolete work cleanup |

## 17. Verification and acceptance

The implementation is complete only after both HTML and client navigation work through stored and live paths.

### Contract and isolation tests

- JSON round-trip for every supported route state and MDX component.
- Invalid node props, unsafe URLs, excessive depth/size, non-finite values, and extra private fields rejected.
- Two tenants with `/overview` never share objects, cache entries, or client data.
- Generated and custom hosts preserve existing canonical metadata and hydrate correctly.
- Forged render IDs, forwarded hosts, object keys, path encodings, prototype keys, and redirect targets cannot change storage scope.
- Unknown/private/preview/snapshot hosts cannot read production saved data through the new endpoint.
- Source artifact reuse after promotion succeeds without equating DB and manifest version IDs.

### Storage and recovery tests

- Manifest appears only after complete referenced output.
- Missing, corrupt, truncated, oversized, and timed-out objects use fallback before response commitment.
- Conditional repair fixes corrupt existing output without stale-writer overwrite.
- HEAD does not poison GET cache.
- No errors or unauthorized responses enter shared caches.
- Partial Workflow execution resumes without returning page bodies in checkpoint state.
- Repeated request misses produce bounded tasks; unknown paths produce none.
- Lost enqueue recovers without further visitor traffic.
- Expired lease and late callback cannot complete a newer attempt.
- Retry exhaustion remains visible and does not loop forever.
- Successful publication survives unavailable pre-render infrastructure.

### Routing and browser tests

- Initial document uses saved HTML without invoking renderer/content data preparation on a validated hit.
- Sidebar navigation and preload use saved data without starting a renderer on a validated cache/R2 hit.
- Missing JSON uses live preparation with the same DTO and visual result.
- The JSON endpoint never follows a fallback cycle.
- Root/section redirects, direct page links, refresh, not-found, empty site, hash links, and back/forward work.
- Cancellation does not cause duplicate fallback requests.
- Publication during navigation produces a bounded version-mismatch response, not mixed data or a reload loop.
- Mode off bypasses stored HTML/data despite old cache entries.
- Preview and permanent-generation routing, access checks, and caching remain unchanged.
- Search, chat, raw Markdown, copy controls, playground, and hydration show no regressions.
- Operational repair errors are retained with DEBUG=false; detailed timing is absent when disabled.

### Commands and evidence

Run targeted API, dispatcher, runtime, template, contract, MDX, and packaging tests for changed modules. Run their typechecks and the real renderer build. Run migration/config validation without applying changes unless authorized. Perform a browser test against the production build, not only Vite development mode.

Report exact commands, outcomes, skipped checks, and external configuration still required. Measure cold saved-output reads and warm edge-cache responses separately. Do not describe browser memory-cache hits as evidence that R2 or SSR improved.

## 18. Implementation checkpoints

1. Reverify repository boundaries. Add failing identity, DTO, and isolation tests. Define shared browser-safe contracts.
2. Extract reusable page preparation and render-prepared-data capability. Prove HTML hydration and JSON parity.
3. Add bounded storage reader/writer, manifest commit protocol, and repair tests.
4. Add private Workflow and API task lifecycle. Integrate every production publication and hostname activation path.
5. Add HTML lookup and existing SSR fallback integration.
6. Add JSON endpoint, production-only loader adapter, internal data cache, and live fallback.
7. Add reconciliation, unconditional operational error logging, mode controls, and local fixtures.
8. Run full relevant verification and browser failure-injection tests. Update architecture/runbook docs with actual behavior.

Do not mark checkpoint 5 as feature completion. Do not introduce the excluded deployment or preview work while implementing later checkpoints.

## 19. References and decision record

- [TanStack static pre-rendering](https://tanstack.com/start/latest/docs/framework/react/guide/static-prerendering)
- [TanStack Static Server Functions](https://tanstack.com/start/latest/docs/framework/react/guide/static-server-functions)
- [Current static middleware source](https://github.com/TanStack/router/blob/main/packages/start-static-server-functions/src/staticFunctionMiddleware.ts)
- [Cloudflare execution context](https://developers.cloudflare.com/workers/runtime-apis/context/)
- [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

Official static-function middleware targets build-output files and has an experimental contract. Option 3 was selected to reuse Doxa's prepared data while controlling publication-time storage, tenant identity, and fallback behavior. The implementing agent must verify current APIs against the project's locked versions.

The user explicitly requested retained repair-failure logs, unchanged preview behavior, no deployment readiness/backfill system, and no subagent-driven development. These constraints are binding.
