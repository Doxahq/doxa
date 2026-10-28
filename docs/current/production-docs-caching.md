# Production Docs Caching

**Status:** Cache and durable invalidation implemented. Migration and production verification are pending rollout. The Workers KV hostname map is implemented and off by default (see [Hostname Map](#hostname-map)).
**Last reviewed:** 2026-10-29
**Scope:** Public production docs served by Dynamic Workers. Not the Doxa dashboard.

## Decision

Use Cloudflare **Workers Cache**, not the older `caches.default` Cache API,
an isolate-local map, or Workers KV. Cloudflare manages storage and cache fills
around named `fetch` entrypoints in the dispatcher. The one exception is the
hostname map: a Workers KV copy of public production hostname resolutions that
the dispatcher can read before `DocsHostCache` (see [Hostname Map](#hostname-map)).

Publishing attempts a native purge after the database commit. A durable database
outbox retries failed attempts. The hostname lifetime remains a fallback; this is
not a strict global read-after-write guarantee.

| Layer                      | Lifetime                    | Identity                                                                                                                       |
| -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Hostname map (Workers KV)  | Used for 1 day after the API read it; KV expires it after 2 days | Normalized hostname (`host:<hostname>`) and `DOCS_HOSTNAME_MAP_FORMAT` in the value                                     |
| `DocsHostCache`            | 1 day, stale on error       | Trusted hostname and `DOCS_HOST_CACHE_FORMAT` in `ctx.props`                                                                   |
| `DocsHtmlCache`            | 1 year, then 7 days stale   | Trusted hostname, resolved site/version/artifact data, renderer build, delivery render ID in `ctx.props`, plus URL path        |
| `DocsRouteDataCache`       | 1 year, then 7 days stale   | Trusted hostname, resolved site/version/artifact data, delivery identity (`renderId`) in `ctx.props`, plus the route-data path |
| Public dispatcher response | Not stored                  | Explicit `private, no-store`                                                                                                   |

The constants live in `apps/docs-dispatcher/src/cache-policy.ts`. The dispatcher
uses Wrangler 4.135.0 or later with per-entrypoint Workers Cache configuration.
The global cache default is disabled, and `cache.cross_version_cache` is
`true`. `exports.default.cache.enabled` is also
explicitly disabled, while `DocsHostCache`, `DocsHtmlCache`, `DocsPrerenderCache`,
and `DocsRouteDataCache` opt into caching.
Other entrypoints inherit the disabled default. The renderer package builder
preserves these settings in the generated deployment config.

The public dispatcher skips the native cache lookup and runs directly. This
avoids an unnecessary round trip through the cache tiers before returning a
response that cannot be stored. Every response returned by the public dispatcher
still sets `Cache-Control`, `CDN-Cache-Control`, and
`Cloudflare-CDN-Cache-Control` to `private, no-store` to prevent storage by the
browser or other HTTP caches. Do not remove this boundary.

## Request Flow

```text
Public HTML request
  → dispatcher checks whether caching is allowed
  → hostname map (DOXA_PROD_KV_HOSTNAME_MODE=on): hostname → public production version
      miss, invalid, too old or KV error → DocsHostCache
  → DocsHostCache: hostname → public production version
      miss → API.resolveDocsHost → database
  → DocsHtmlCache: host + site + version + build + path → HTML
      miss → pinned Dynamic Worker → docs runtime → versioned artifacts
  → dispatcher returns HTML with no-store headers

Client navigation (route-data cache rollout on, no pre-render)
  → GET /_doxa/route-data/v1?path=/guide&render=<hint>
  → DocsHostCache: hostname → public production version
  → dispatcher computes the delivery renderId; a stale hint gets HTTP 409
  → DocsRouteDataCache: host + renderId + path → route-data JSON
      miss → PrerenderRendererApi.prepare → pinned renderer → versioned artifacts
  → dispatcher wraps the JSON in the public envelope with no-store headers
```

The route-data cache is the lazy form of saved route data. The first request
for a page and version renders it. Every later request, in every region, reads
the stored copy. It has a separate rollout:
`DOXA_PROD_ROUTE_DATA_CACHE_MODE` (`off`, `allowlist`, or `all`) and
`DOXA_PROD_ROUTE_DATA_CACHE_SITE_IDS`. The default is `all` in the dispatcher
config, the package script, and the deploy script, so every deployment enables
it for every public production site. `pnpm validate:production-config` rejects
a dispatcher config with another default. For an emergency rollback, deploy with
`--route-data-cache-mode off`. If pre-rendering includes the site,
saved output has priority. When either rollout includes a public production
site, the dispatcher sends the delivery `renderId` to the renderer. The HTML
then carries `window.__DOXA_DOCS_DELIVERY__`, and client navigation uses the
route-data endpoint in place of the TanStack server function.

`DocsHtmlCache` keys on that `renderId` too. A deploy that changes only client
assets keeps the build ID but changes the `renderId`, and the HTML embeds both
the ID and the asset links.

The API still owns hostname resolution. Neither the browser nor URL parameters
can supply a site ID, version ID, artifact prefix, or access policy.

Workers Cache does **not** include the URL hostname in its default key. Doxa
passes the hostname through trusted `ctx.props` to separate domains. The full
resolved production record also separates sites and versions. The page path is
part of Cloudflare's native key.

Cloudflare separates deployed Worker versions by default, so each deploy starts
with an empty cache. The dispatcher sets `cache.cross_version_cache` to `true`
to share entries across versions. A dispatcher-only deploy then keeps every
cached page. This is safe because the props already pin each content entry:

- HTML: the site version, the renderer build ID, and the delivery render ID.
- Route data and saved output: the delivery identity, which contains the
  renderer release.
- Hostname mappings: `DOCS_HOST_CACHE_FORMAT`. Increase it when the cached
  resolution JSON changes shape.

A change outside these identities does not reach cached content. Examples are
a dispatcher variable that is passed to the renderer, such as
`DOXA_API_BASE_URL`, or a change to the dispatcher code that wraps HTML before
it is stored. After such a change, deploy a new renderer build, or turn off
`cross_version_cache` for one deploy. `pnpm validate:production-config` rejects
a dispatcher config without the flag.

The cacheable HTML subrequest has canonical headers: `Accept: text/html` only.
Visitor headers such as forwarded hosts, language preferences, and user agents
cannot alter a shared HTML fill. Public SSR must stay independent of those
headers. Revisit this design before adding server-side personalization.

Custom RPC methods are not cached by Workers Cache. `DocsHostCache.fetch()`
wraps the existing API RPC call so Cloudflare can cache its response. The scoped
content RPC still pins each renderer read to the resolved version.

## Freshness and Promotions

Every eligible page request checks the hostname cache before the
HTML cache. A promotion changes the published database version ID, even when it
reuses an older artifact prefix. That new ID selects a different HTML cache
entry. An in-flight fill for the previous version cannot overwrite it.

The 1-year HTML lifetime does **not** make production changes wait.
After commit, the API attempts to purge all hostname mappings tagged with the
site ID. That removes the intentional TTL wait during normal publishing. The
next lookup reads the new pointer and selects its version-specific HTML entry.

A purge can fail or be delayed. An old lookup that was already running can also
finish after the publish or purge and put an old mapping back into the cache.
That mapping would live for a day from its cache fill
(`DOCS_HOSTNAME_CACHE_TTL_SECONDS`). Therefore every enqueue also queues a
follow-up purge two minutes later, which the scheduler delivers within about
seven minutes. The follow-up removes such a late fill. Storage that a cached
hostname can still point to (retired versions, deleted sites, pre-rendered
output) waits `HOSTNAME_READER_GRACE_SECONDS`, 25 hours, before collection.
The outbox health counts a task as delayed only after it has waited longer
than one scheduler run plus a minute.
A page response already in progress can still return the old version. An already
open browser page does not update itself.

Cache lifetimes have names in `cache-policy.ts`:

| Lifetime       | Entries                                                    | `Cache-Control`                                                                 |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `hostname`     | `DocsHostCache`                                            | `public, max-age=86400, stale-if-error=604800`                                  |
| `liveFallback` | Live output after a saved-output miss                      | `public, max-age=30, must-revalidate`                                           |
| `versioned`    | HTML, saved HTML and data, and `DocsRouteDataCache` output | `public, max-age=31536000, stale-while-revalidate=604800, stale-if-error=604800` |

Version-keyed entries can serve stale copies, because a publish selects a new
key and never changes content under an existing key. A stale copy is identical
to a fresh one. The lifetime is 1 year because only a new key or a purge can
make an entry wrong. Cloudflare can still evict an entry that gets no traffic.
After 1 year Cloudflare returns the stored copy and refreshes
it in the background. If the refresh fails, it keeps the stored copy. Do not add
`must-revalidate`, `s-maxage`, or `proxy-revalidate` to `versioned`: each one
disables stale serving.

The hostname mapping has no `stale-while-revalidate`, because a publish changes
it, and a publish purges it. It has `stale-if-error`. If the resolver fails
after the hour, Workers Cache serves the last mapping, so a cached site stays up
during an API outage. Do not add `must-revalidate` to it: that disables
`stale-if-error`. A purged mapping cannot be served stale.

Domain removal, disabling, or reassignment also requests a purge, but has the
same possible short stale-mapping window. This is an accepted limit for public
production docs, not a suitable policy for immediate access revocation. Previews
and authenticated resolutions are not stored. Revisit this design before adding
private production sites.

All inputs used to render cacheable HTML must remain versioned. Do not change
published artifacts in place. A future mutable branding, feature, or access
setting needs a new version/cache identity or explicit invalidation.

## Hostname Map

A `DocsHostCache` miss calls the resolver Worker next to the database in
`aws:us-east-1`. From Singapore that lookup cost about 900 ms, from Europe
about 200 ms. Workers KV is replicated to every data center, so the dispatcher
can read a copy of the resolution near the visitor.

### Shape

- The namespace binds only to the dispatcher (`DOCS_HOSTNAME_MAP`, namespace
  `doxa-docs-hostname-map`, ID placeholder `${CF_DOCS_HOSTNAME_MAP_KV_ID}`).
  The API has no KV binding. It sends entries through the private
  `DocsHostCache.syncHostnames` RPC, on the same `DOCS_CACHE_INVALIDATOR`
  binding as the purge. The Node origin reaches it through the bridge.
- Key: `host:<hostname>`, lowercase and without a trailing dot. Value:
  `{ format, resolvedAt, resolution }`. `resolvedAt` is when the API read the
  database (epoch ms). The contract is `@doxahq/contracts/docs-hostname-map`.
- The API computes every entry with `resolveDocsHost`, the function that the
  resolver Worker runs, from the database state at delivery time. Never from
  the caller of a mutation.

### Writes

The writes reuse the `docs_cache_invalidations` outbox. Every task that purges
`DocsHostCache` also rewrites the map, so every covered mutation in the table
below updates it, including the follow-up two minutes later:

1. The worker resolves every hostname that the task can affect: the task's
   hostname, the site's generated hostname, and every domain row of the site
   in any state. Project deletion already queues one task per hostname, so a
   deleted site's hostnames are covered after its rows are gone.
2. A public production resolution of the same hostname becomes a put. Anything
   else (no resolution, preview, generation snapshot, authenticated site, or
   another hostname's resolution) becomes a delete.
3. The purge and the sync run in parallel, each with a three-second timeout.
   The task completes only when both succeed. A failed sync records
   `hostname_sync_failed` or `hostname_sync_timeout` and retries with the
   normal backoff. A retry repeats both; each reads the current state again.
4. One claimed batch reads and writes each hostname once. Every claimed task
   committed before the claim, so one read after the claim sees all of them.

The dispatcher checks the input again with Zod, stores only a public production
resolution whose hostname matches the key, and deletes the key for every other
update. A put sets a KV `expirationTtl` of two days
(`DOCS_HOSTNAME_MAP_EXPIRATION_SECONDS`), so KV removes an orphan by itself.
Without the namespace binding `syncHostnames` does nothing.

### Reconcile and backfill

The API scheduler runs `DocsHostnameMapReconciler` every five minutes. It
lists the hostnames that can be public production now (the generated hostname
of every published site, and every active, verified domain of a published
site), keeps those in this run's slot (FNV-1a of the hostname modulo 144), and
syncs them. Every public hostname is rewritten once every 12 hours
(`DOCS_HOSTNAME_MAP_REFRESH_SECONDS`). It reads the database and writes only
the map; it logs `docs_hostname_map_reconcile` with the slot and the counts.
It is the backfill for existing sites: 12 hours after the first deployment
with the namespace bound, every public hostname has an entry. It does not run
without the `DOCS_CACHE_INVALIDATOR` binding, for example in local development.

### Reads and rollout

`DOXA_PROD_KV_HOSTNAME_MODE` in `apps/docs-dispatcher/wrangler.json`:

- `off` (default): the dispatcher does not read the map. The API still writes
  it once the namespace is bound.
- `shadow`: the dispatcher reads the map and `DocsHostCache` in parallel,
  serves the `DocsHostCache` answer and logs the agreement.
- `on`: a valid map hit serves the request and skips `DocsHostCache`. A miss,
  an invalid or too old entry, a KV error or a missing binding falls back to
  `DocsHostCache` and the resolver, as before.

An invalid value logs a warning and means `off`.
`pnpm validate:production-config` accepts only the three values and requires
the `DOCS_HOSTNAME_MAP` binding.

A read is a hit only when the value parses with the Zod schema, has the current
format, is a public production resolution of the requested hostname,
`resolvedAt` is not more than five minutes in the future, and `resolvedAt` is
at most one day old (`DOCS_HOSTNAME_MAP_MAX_AGE_SECONDS`, equal to
`DOCS_HOSTNAME_CACHE_TTL_SECONDS`). Previews, generation snapshots and
authenticated resolutions are never stored and always reach the resolver.

`docs_request_cache` (and `docs_request_timing`) gain `hostSource` (`kv`,
`cache` or `resolver`) when the request resolved its hostname, and
`hostnameMap: { mode, status, agreement? }` when the mode is not `off`.
`status` is `hit`, `miss`, `invalid`, `expired`, `error` or `unbound`.
`agreement` (shadow only) is `agree`, `missing` (a public hostname without a
usable entry), `disagree` (another resolution, or an entry for a hostname that
is no longer public production) or `error`. The `x-doxa-host-source` response
header carries the source. A `DocsHostCache` status of `HIT`, `STALE` or
`UPDATING` counts as `cache`; any other status counts as `resolver`.

### Consistency and worst case

KV is eventually consistent. A write reaches the other data centers within
about 60 seconds: a data center that read the key recently serves its cached
copy until it expires. With the mode `on`:

- After a publish, promotion or domain change, a data center can serve the
  previous mapping for up to about 60 seconds after the immediate delivery.
  Without the map, the purge removes the mapping in a few seconds.
- A lookup that read the database before the commit can write the old mapping
  after the new one, as with `DocsHostCache`. The follow-up task two minutes
  later reads the database again and rewrites the key, so this window is at
  most about seven minutes plus propagation. KV has no compare-and-set, so a
  delayed write cannot be fenced.
- A failed sync retries with the outbox backoff. The purge is not held back
  by it.
- If every write for a hostname were lost (for example a mutation that the
  outbox does not cover), the dispatcher stops using the entry one day after
  `resolvedAt`, the same bound as the hostname cache. Storage that an entry
  can point to waits `HOSTNAME_READER_GRACE_SECONDS` (25 hours), so an entry
  never points at deleted storage. The reconcile repairs a live hostname
  within 12 hours.

In `shadow` mode a short `disagree` after a publish is expected: either side
can be the stale one during the windows above. Persistent `disagree` or
`missing` for one hostname is a bug to fix before `on`.

### Provisioning, rollout and revert

1. Create the namespace once: `wrangler kv namespace create
   doxa-docs-hostname-map`. Put its ID in
   `doxa-ops/wrangler/production-ids.json` as `CF_DOCS_HOSTNAME_MAP_KV_ID`.
   The production deploy fails at the placeholder check without it.
2. Deploy normally. The `docs-rendering` step deploys the dispatcher before the
   API. The Node origin goes before the thin `doxa-api` Worker, so for a few
   minutes the edge refuses `syncHostnames`: those tasks retry and still purge.
3. Set the mode to `shadow` and deploy `docs-rendering`. Wait at least 12
   hours for the reconcile, then check that `agreement` is almost always
   `agree`.
4. Set the mode to `on` and deploy `docs-rendering`. Compare `hostSource` and
   `doxa_resolve` timings by `colo`.

To revert, set the mode to `off` and deploy `docs-rendering`; every lookup
uses `DocsHostCache` again. The API writes stay harmless. To stop the writes
too, remove the `DOCS_HOSTNAME_MAP` binding: `syncHostnames` then does
nothing. When the entry shape changes, increase `DOCS_HOSTNAME_MAP_FORMAT`:
the dispatcher then treats older entries as misses until the reconcile
rewrites them.

## Durable Invalidation

The API writes a `docs_cache_invalidations` task in the same transaction as the
production pointer or domain change. A rollback saves neither change. After a
successful commit, it attempts the task through the private
`DOCS_CACHE_INVALIDATOR` service binding to `doxa-docs-renderer#DocsHostCache`.
There is no public purge route, browser request, new API token, or new queue.

`DocsHostCache.invalidate` uses native `ctx.cache.purge({ tags })` and checks
`success`. The same delivery rewrites the hostname map through
`DocsHostCache.syncHostnames` (see [Hostname Map](#hostname-map)). A missing cache context, rejected RPC, or unsuccessful result is a
failed attempt. Custom RPC methods are not cached. Purge targets the owning
hostname-cache entrypoint, not the HTML entrypoint or the older Cache API.

Every scheduled retry batch also reads an aggregate health snapshot from the
outbox and emits a `docs_cache_invalidation_health` structured log. The event
contains completed and failed work from that batch plus pending, delayed,
failed, oldest-age, and maximum-attempt counters. `delayedCount` means a task is
due and has no active lease. The event is logged as a warning when delayed or
failed work remains, so production log alerts can target one stable event name
without exposing site IDs or hostnames.

Public production hostname responses receive encoded `docs-site:` and
`docs-host:` tags. A site purge covers generated and custom production hostnames
without listing them. Domain changes include the hostname tag too, so a cached
mapping from a previous site can be removed. Tags use union matching. Tags are
stripped from public responses; private and preview responses are not tagged.

### Covered mutations

| Change                                                      | Invalidation                       |
| ----------------------------------------------------------- | ---------------------------------- |
| Generation publication through `publishJob`                 | Site tag                           |
| Production completion through `completeJob`                 | Site tag                           |
| Manual generation promotion through `promoteForProject`     | Site tag                           |
| Web editor publication through `createContentVersion`       | Site tag                           |
| Custom domain creation or deletion                          | Site and hostname tags             |
| Domain gains or loses active + verified routing eligibility | Site and hostname tags             |
| Domain status refresh with unchanged routing eligibility    | None                               |
| PR preview completion, closure, or expiry                   | None: previews bypass these caches |
| Rejected, blocked, or idempotent publication                | No new task                        |

An automatic generation that publishes to production follows the same
`completeJob` path. A PR preview build alone does not change production. If its
version is later promoted to production, the promotion path invalidates the site.

### Retry and failure behavior

- The immediate attempt happens **after commit**. No purge network call runs
  while publication locks are held. A purge failure does not report a committed
  publication as failed.
- The API's existing `*/5 * * * *` scheduler processes pending tasks independently
  of the generation queue outbox.
- A short database transaction claims up to 25 due tasks using
  `FOR UPDATE SKIP LOCKED`. Each claim has a new token and a 120-second lease.
- Each purge attempt has a three-second timeout. Tasks run sequentially. A timed
  out RPC may still finish, but it cannot acknowledge the timed-out task later.
- Retry delays start at 30 seconds, double per failed attempt, and stop increasing
  at one hour. These are earliest retry times: actual retries wait for the next
  five-minute scheduler run and available batch capacity.
- There is no retry-count cutoff. A crashed worker leaves a lease which can
  expire and be claimed again. Completion and failure writes require the current
  claim token, so an old worker cannot acknowledge a newer claim.
- Duplicate or delayed purges are safe: they evict a mapping and do not restore
  any old content. A crash after purge but before acknowledgement causes a retry.
- Tasks have no site/domain foreign key, so deletion cannot erase pending work.
  Successful tasks remain with `completed_at` set. Automatic retention cleanup
  is not included in this first version; add it before the table grows large.
- Warnings identify task ID, attempt count, and a safe error code. Inspect pending
  rows, `next_attempt_at`, `lease_until`, and `last_error` if retries do not drain.

Local development has no dispatcher binding. Mutations still store outbox tasks,
but skip the immediate delivery attempt. Normal `.localhost` rendering stays
uncached. If the scheduler is run locally without the binding, tasks remain
pending with `binding_missing`; they are not silently marked complete.

## Bypasses and Failures

The initial request policy is deliberately narrow:

- Only HTTPS `GET` and `HEAD` requests accepting HTML can use the cache.
- Any cookie, authorization, range, upgrade, cache-control, or pragma header
  bypasses the HTML cache. A browser reload can therefore bypass HTML caching.
  Every request resolves its hostname through `DocsHostCache`, also a
  visitor-specific request. The resolution depends only on the hostname, and only public
  production mappings are stored. A reload therefore does not bypass the
  hostname mapping; freshness after a publish depends on the purge.
- Any query string bypasses caching, including demo and framework data requests.
- API routes, underscore-prefixed routes, dotted paths such as assets and
  markdown, and malformed/unsafe encoded paths bypass caching.
- Unknown hosts, private resolutions, previews, and permanent generation URLs
  are not stored in the hostname cache. They cannot use the HTML cache.
- Only HTTP 200 HTML without `Set-Cookie`, `Vary`, or explicit private/no-cache/
  no-store directives can be stored by the HTML entrypoint.
- Renderer errors and redirects are not cached. Existing safe shared-renderer
  fallback remains available and is never stored under a pinned version's key.
- Dynamic mode `off` bypasses hostname resolution and both cache entrypoints.

Fingerprint-named static assets served directly by the existing Workers Assets
binding keep their existing behavior. Local `.localhost` development is outside
this HTML cache. No preview access rules or dashboard code were changed.

## Verification and Operations

Every request writes one `docs_request_cache` log line with the hostname,
path, status, cache statuses, data center (`colo`) and, once the hostname is
resolved, `hostSource` and `hostnameMap` (see [Hostname Map](#hostname-map)). With `DEBUG` set to
`true`, the line is `docs_request_timing` and also carries the timings. Every
renderer call writes `docs_renderer_load` with the isolate scope, the build,
`COLD` (this request started the isolate) or `WARM`, the code load time, the
total time and the outcome (see
[Renderer Isolate Scope](./production-docs-content-injection.md#renderer-isolate-scope)).
docs-runtime writes `docs_runtime_reads` for every
`getRouteData` call, with the number of artifact reads that passed the memory
caches, their total time and the longest read. `getRouteData` starts its
independent reads together. Use these lines for the hit rate and for slow
misses.

The gateway adds `x-doxa-host-cache` and `x-doxa-html-cache` for diagnostics.
The route-data endpoint adds `x-doxa-route-data-cache`.
These copy the respective internal response's `CF-Cache-Status` when present.
`BYPASS` means the entrypoint was not used. `UNAVAILABLE` means it was invoked
but Cloudflare supplied no status; it does not mean a cache hit. On a shared
fallback, the HTML diagnostic describes the attempted dynamic response, not the
fallback response. Use `x-doxa-renderer-mode` to distinguish them.

Local checks cover request/response policy, trusted cache props, scoped renderer
bindings, fallback behavior, and generated deployment configuration. They do
not simulate Cloudflare's storage or prove native cache hits, TTL expiry, or
global propagation. Wrangler dry-run checks bundling/config only.

After an approved deployment:

1. Request an actual public page twice, for example `/overview`, with
   `Accept: text/html`, no cookies, and no query string. Check for native cache
   hits in the two diagnostic headers. A root redirect is not cacheable.
2. Check two projects at the same path, then a generated and custom hostname.
   Each must serve the correct site's content and domain-specific links.
3. Warm a page, publish a new version, and request it immediately. Confirm a
   completed outbox task and the new version. Repeat for promotion of an older
   version and web editor publication. Check both generated and custom domains.
4. Check cookies, authorization, reload, preview, health, search, chat, and
   markdown requests. These must retain their original behavior without shared
   HTML caching.
5. Compare warm and cold timings. Do not infer a performance score from a HIT
   header alone.
6. Test domain removal and loss of routing eligibility. Confirm the old hostname
   mapping is invalidated. Test temporary purge failure in a safe test environment
   and confirm a later scheduler run completes the task without another publish.

Use the existing `pnpm deploy:docs-template` workflow to build/package the
renderer and deploy its generated dispatcher config. Do not deploy the raw
dispatcher config: its renderer build/package values are placeholders.
The invalidation addition requires the API deployment and migration
`0021_docs_cache_invalidations.sql`. It does not require a new bucket, secret,
docs-runtime deployment, or dashboard deployment.

First-rollout order, after approval:

1. Apply migration 0021 to each environment before running the updated API.
2. Deploy the dispatcher through `pnpm deploy:docs-template`. It must export
   `DocsHostCache.invalidate` before the API binds to it.
3. Deploy the API with its production `DOCS_CACHE_INVALIDATOR` binding.
4. Run the smoke checks above. A dry-run does not verify a deployed RPC binding
   or global cache purge behavior.

Do not use the current API-first `deploy:all` order for the **first** rollout of
this feature. Once the dispatcher entrypoint exists, normal deployment order can
resume. Keep the outbox table if rolling the API back; do not delete pending work.

To turn off native caching, set `exports.DocsHostCache.cache.enabled`,
`exports.DocsHtmlCache.cache.enabled`, and
`exports.DocsRouteDataCache.cache.enabled` to `false`, then redeploy through the same
workflow. The global `cache.enabled` is already `false`; it does not override
these explicit opt-ins. Both entrypoints continue to serve requests without
stored responses.

### Test Strategy

- Unit tests: request eligibility, privacy headers, TTL headers, tenant/version
  identity, errors, redirects, and encoded paths.
- Boundary tests: real dispatcher/entrypoint methods with stubbed Cloudflare
  bindings; verify pinning and fallback, not a fake native-cache implementation.
- Invalidation tests: transaction commit/rollback order; generation, promotion,
  editor and domain hooks; preview bypass; timeout, backoff, missing binding,
  failed purge results, scheduler independence, and safe tag encoding.
- SQL tests: real Drizzle-generated claims and token-guarded updates with a stubbed
  pg transport. These do not prove PostgreSQL lock behavior under concurrent load.
- Packaging tests: generated deployment config disables the public cache lookup
  and retains the two internal cache opt-ins.
- Deployment smoke: the five checks above; deferred until deployment approval.
- UI/component tests are not needed because this change has no UI surface.
- API-to-dispatcher invalidation uses a shared Zod input and RPC type. The first
  rollout must verify this cross-service contract with a real purge.
- Property testing is deferred; the selected policy branches and identity
  changes have deterministic table-driven tests.

## Later Work

For strict global freshness, address old fills already in flight with a stronger
version/fencing design. Native purge plus durable retries reduces stale reads but
does not provide a global read-after-write guarantee. Do not replace native purge
with local `caches.default.delete()`; that is a different cache.

Future project/site deletion, slug changes, unpublishing, mutable rendering
settings, or private-production access changes must add appropriate invalidation
or versioning. These mutation paths are not implemented here. Add outbox
retention and higher-throughput delivery if publishing volume requires it.

Revisit query handling, harmless cookies, and response variation after measuring
real traffic. Private previews need a separate authorization-aware design; never
put their HTML into this public cache.

## References

- [Workers Cache configuration](https://developers.cloudflare.com/workers/cache/configuration/)
- [Cache keys and trusted props](https://developers.cloudflare.com/workers/cache/cache-keys/)
- [Named entrypoint examples](https://developers.cloudflare.com/workers/cache/examples/)
- [Workers Cache limitations](https://developers.cloudflare.com/workers/cache/limitations/)
- [Workers Cache purge](https://developers.cloudflare.com/workers/cache/purge/)
