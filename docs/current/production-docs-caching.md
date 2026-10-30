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
| `DocsHtmlCache`            | 30 days, then 7 days stale  | Trusted hostname, resolved site/version/artifact data, renderer build, delivery render ID in `ctx.props`, plus URL path        |
| `DocsRouteDataCache`       | 30 days, then 7 days stale  | Trusted hostname, resolved site/version/artifact data, delivery identity (`renderId`) in `ctx.props`, plus the route-data path |
| Warm state (Workers KV)    | Until the warm job writes the next release | `warm:<siteId>` in the hostname-map namespace; see [Previous-build fallback](#previous-build-fallback) |
| `DocsRendererCodeCache`    | 30 days, then 7 days stale  | The deployed `DOXA_RENDERER_BUILD_ID`, `DOXA_RENDERER_PACKAGE_KEY` and `RENDERER_CODE_CACHE_FORMAT` in `ctx.props`, plus `/v1/{buildId}` |
| `DocsTextCache`            | 30 days, then 7 days stale  | Trusted hostname, resolved site/version/artifact data, renderer build, delivery render ID, route (`llms`, `llms-full`, `md`) and `DOCS_TEXT_CACHE_FORMAT` in `ctx.props`, plus URL path. Behind `DOXA_PROD_TEXT_ROUTE_CACHE_MODE` |
| `DocsClientAssetCache`     | 1 year (hit), 60 s (miss)   | The client file name and `CLIENT_ASSET_CACHE_FORMAT` in `ctx.props`, plus `/v1/{file}`. Behind `DOXA_PROD_CLIENT_ASSET_FALLBACK_MODE` |
| Public dispatcher response | Not stored                  | Explicit `private, no-store`                                                                                                   |

The constants live in `apps/docs-dispatcher/src/cache-policy.ts`. The dispatcher
uses Wrangler 4.135.0 or later with per-entrypoint Workers Cache configuration.
The global cache default is disabled, and `cache.cross_version_cache` is
`true`. `exports.default.cache.enabled` is also
explicitly disabled, while `DocsHostCache`, `DocsHtmlCache`, `DocsPrerenderCache`,
`DocsRouteDataCache`, `DocsRendererCodeCache`, `DocsTextCache` and
`DocsClientAssetCache` opt into caching.
Other entrypoints inherit the disabled default. The renderer package builder
preserves these settings in the generated deployment config.

The public dispatcher skips the native cache lookup and runs directly. This
avoids an unnecessary round trip through the cache tiers before returning a
response that cannot be stored. Every response returned by the public dispatcher
still sets `Cache-Control`, `CDN-Cache-Control`, and
`Cloudflare-CDN-Cache-Control` to `private, no-store` to prevent storage by the
browser or other HTTP caches. Do not remove this boundary. There is one
exception, behind a flag: a route-data answer for a matched render hint can
stay in the browser cache (see
[Route Data in the Browser Cache](#route-data-in-the-browser-cache)). The two
CDN headers stay `private, no-store` for it too.

The docs runtime has its own Workers Cache entrypoint, `DocsBlobCache`, for
the immutable blobs and trees that it reads from R2. See
[Docs Content Storage](docs-content-storage.md#tiered-blob-cache-of-the-docs-runtime).

## Cache Topology

Workers Cache is a tiered cache with a fixed topology: Cloudflare's "generic
global" tiered cache. Doxa cannot change it. A data center that misses asks
an upper-tier data center in its region pool. Only on a miss there does the
entrypoint run. See
[Workers Cache limitations](https://developers.cloudflare.com/workers/cache/limitations/)
and [Tiered Cache](https://developers.cloudflare.com/cache/how-to/tiered-cache/).

Consequences:

- One fill serves one upper-tier pool, not the world. The first request for a
  page and version in each pool runs the entrypoint (a render, or a
  `prepare` for route data).
- Cold traffic from several regions causes several fills of the same key.
  Each fill stores the same bytes, because the key is versioned.
- A warm-up must fill each pool that serves visitors, not one location.

Evidence (29 Oct 2026, production tail): fills of the same cache entries ran
in NRT, ICN and KIX, and also in DFW, LAX, SEA, SJC and DEN.

Pool map (spike S1, 29 Oct 2026, a throwaway Worker with one Durable Object per
location hint). A fill from one Durable Object was a HIT for every probe in its
pool (20 of 20) and for no probe in another pool. Inside a pool, each key goes
to one upper-tier data center, chosen by a hash of the key.

| Pool | Data centers seen | Durable Object hints that land there |
| --- | --- | --- |
| US-West | SEA, SJC, LAX, DFW, DEN | `wnam` |
| US-East | IAD, EWR, ATL, ORD, MIA | `enam`, `sam` |
| EU-West | CDG, AMS, MAD, MRS, BCN | `weur`, `afr` |
| EU-East | FRA, ARN, WAW, MXP, OTP | `eeur`, `me` |
| Asia-NE | NRT, ICN, KIX | `apac-ne`, sometimes `apac` |
| Hong Kong | HKG, TPE | sometimes `apac` or `apac-se` |
| Singapore | SIN | sometimes `apac-se` |
| Oceania | SYD, MEL, BNE, PER | `oc` |

The Asia hints do not choose a fixed pool: each new Durable Object can land in a
different one. Mumbai, Jakarta, South America and Africa have no Durable Object
location, so their pools are not known yet.

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
for a page and version renders it. Later requests that reach the same
upper-tier pool read the stored copy; a request in another pool fills that pool
once (see [Cache Topology](#cache-topology)). It has a separate rollout:
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

The 30-day HTML lifetime does **not** make production changes wait.
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
| `versioned`    | HTML, saved HTML and data, `DocsRouteDataCache` output, `DocsTextCache` output, and the renderer code package | `public, max-age=2592000, stale-while-revalidate=604800, stale-if-error=604800` |

Version-keyed entries can serve stale copies, because a publish selects a new
key and never changes content under an existing key. A stale copy is identical
to a fresh one. Only a new key or a purge can make an entry out of date, so the
lifetime does not control freshness. It is 30 days, like the 15 days that
Mintlify uses for its page cache, so that an entry stored wrong (for example a
bad render) ends without a new key. Cloudflare can still evict an entry that
gets no traffic. After 30 days Cloudflare returns the stored copy and refreshes
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
Every put also sets the KV metadata `{ siteId }`, so the regional warm sweep
can list a site's hostnames without reading each value (F26). Entries written
before this change have no metadata until the next rewrite (at most 12 hours,
the reconcile refresh). Without the namespace binding `syncHostnames` does
nothing.

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

## Previous-build fallback

**Status:** implemented, `DOXA_PROD_PREVIOUS_FALLBACK_MODE=off` by default
(M26). It reads the warm state that the regional warm job (M28) writes, so
turn it `on` only after the warm job runs.

Workers Cache fills one upper-tier pool per key (spike S1 measured 8 pools).
After a renderer deploy every page has a new key (the build ID and the render
ID change), and the first visitor of each page in each pool waits for a
render. The fallback serves that visitor the previous build's cached output
instead, until the warm job has filled the visitor's pool, for at most
`DOXA_PREVIOUS_FALLBACK_BUILD_WINDOW_SECONDS` (default 86400) after
`DOXA_RENDERER_DEPLOYED_AT`. The previous build is never rendered. Nothing is
purged and no key changes shape.

### Entrypoint protocol

`DocsHtmlCache`, `DocsRouteDataCache`, `DocsPrerenderCache` (and the text
cache) run every call through `serveVersionedEntrypoint`
(`apps/docs-dispatcher/src/versioned-entrypoint-protocol.ts`), in this order:

1. **ETag/304.** Every response stored with the versioned lifetime carries a
   strong ETag that hashes the entrypoint name and its props
   (`"doxa1-<sha256>"`). A request whose `If-None-Match` matches gets a 304
   with the versioned `Cache-Control` before any other check. The ETag comes
   from the props, which only the dispatcher sets, so the 304 trusts nothing
   from the request. It comes before the trust check on purpose: Cloudflare
   replays the original request headers on a refresh, and a replayed header
   that the trust check refuses (for example `cache-control`) would get a 400,
   which deletes the stored entry. Only Cloudflare's stale-while-revalidate
   refresh sends `If-None-Match`: the dispatcher builds each canonical request
   from scratch, and a test checks that no builder copies it. Spike S2 showed that
   a refresh started by a probe is replayed with the probe header; without the
   304, the 204 marker would delete the stored entry (F39). 30-second live
   fallbacks and uncacheable responses get no ETag.
2. **Trust and build check.** The entrypoint's own checks, then the build:
   the deployed `DOXA_RENDERER_BUILD_ID` (HTML) or `DOXA_RENDERER_RELEASE_ID`
   (route data and saved output). The previous build or release is accepted
   **only for a probe**. A real call with any other identity gets 400 and never
   renders the deployed code under an older key (F14).
3. **Probe.** `x-doxa-cache-probe: 1` asks whether a key is stored. Workers
   Cache answers a stored key itself (HIT, p95 11 ms in S2). On a miss the
   entrypoint returns 204, `x-doxa-cache-probe: miss` and `private, no-store`.
   It never renders and never reads R2. The marker is never cacheable (F40).

A probe miss stops concurrent real calls of the same key from collapsing, and
a real call during it is not stored, for over a minute (F38). So the
dispatcher **never probes a live key**; it probes only previous-build keys,
which nobody fills. A real call that still receives the marker retries once,
then renders without the cache (`docs_cache_probe_marker_received`). The
gateway removes the marker from every public response. Inbound `x-doxa-*`
headers never reach an entrypoint.

### Shared cache-call builder

`selectPublicCacheCalls({ hostname, origin, pathname, resolution, env, build })`
(`apps/docs-dispatcher/src/public-cache-calls.ts`) returns the exact
entrypoint, props and canonical request of a page:

- Sites with saved output (M36): two `DocsPrerenderCache` calls, HTML (the
  page URL, `accept: text/html`) and data (`origin + /_doxa/route-data/v1 +
  normalized path`, `accept: application/json`).
- Other sites: `DocsHtmlCache` (versioned) and, with the route-data cache
  rollout, `DocsRouteDataCache`.

The visitor path, the fallback (with `build` set to the previous build) and
the warm job use it. It needs no visitor request. `tests/public-cache-calls.test.ts`
freezes every props shape and canonical request (F17): a shape change empties
the cache and disables the fallback for one deploy.

### Warm state

Key `warm:<siteId>` in the `DOCS_HOSTNAME_MAP` namespace. Value
(`@doxahq/contracts/docs-warm-state`):
`{ format: 1, releaseId, pools: { "<pool>": doneAt } }`. Pools:
`us-west`, `us-east`, `eu-west`, `eu-east`, `asia-ne`, `hong-kong`,
`singapore`, `oceania`. Only the warm job writes it, through the site's warm
lock, when a pool finishes the deployed release (see
[Regional warm job](#regional-warm-job)). The dispatcher only reads it,
inside the window, for sites in the warm rollout. A missing, malformed or
other-release record means "not warm". KV reads can be about 60 seconds old;
that only extends the fallback a little.

`poolForRequest(request.cf)` (`warm-pool.ts`) maps the data center to a pool
with the S1 colo table, then guesses from the country, continent and longitude.
India and Indonesia are not measured: they get `null`, and `null` means no
fallback (a live render, as before).

### Request flow

```text
HTML GET, public production, cacheable
  1. today's path unless: mode shadow|on, a previous build is set, inside the
     window, site in the warm rollout, and the pool is known
  2. warm:<siteId> says the pool finished the deployed release → today's path
  3. probe the previous build's key (DocsHtmlCache)
       HIT  → serve it, x-doxa-html-cache: PREVIOUS (no background fill)
       miss → today's path
M36 site: the saved-output call for the deployed release runs first; only
after its 404, steps 1–3 probe the previous release's DocsPrerenderCache key
(F16), before the 30-second live fallback.

Route data with render hint = the previous build's render ID
  inside the window, mode on, site in the warm rollout
  → probe the previous key (DocsRouteDataCache or DocsPrerenderCache data)
       HIT  → 200, envelope renderId = the previous render ID (F15),
              x-doxa-route-data-cache: PREVIOUS
       miss → 409 version_mismatch (the client reloads)
```

A page served as `PREVIOUS` embeds the previous render ID, so its client
navigation stays on the previous build until a reload. The HTML links the
previous build's client assets: the old-asset fallback (M27) must be on before
this mode is `on`. HEAD requests, private sites, previews and branch hosts
never use the fallback.

Settings (dispatcher vars):

| Variable | Values | Default |
|---|---|---|
| `DOXA_PROD_PREVIOUS_FALLBACK_MODE` | `off`, `shadow`, `on` (invalid → `off` + warning) | `off` |
| `DOXA_PREVIOUS_FALLBACK_BUILD_WINDOW_SECONDS` | 1–604800 (invalid → no fallback) | `86400` |
| `DOXA_PROD_WARM_MODE`, `DOXA_PROD_WARM_SITE_IDS` | `off`, `allowlist`, `all`; the warm job uses the same rollout | `off`, empty |
| `DOXA_PREVIOUS_RENDERER_BUILD_ID`, `DOXA_PREVIOUS_RENDERER_RELEASE_ID`, `DOXA_RENDERER_DEPLOYED_AT` | written by the deploy; empty in the committed config | empty |

The deploy decides the previous build from a release record in R2 and the
required `--previous-fallback on|off`; a rollback empties it automatically.
See [Docs Artifact Compatibility](./docs-artifact-compatibility.md#previous-build-fallback).

Logs: `docs_request_cache` gains `fallback { mode, used, pool, warmState,
probe, probeMs }` whenever step 1 passed. Shadow mode serves today's path and
logs `docs_request_cache_fallback { …, wouldServe }` from `waitUntil`. Route
data logs `docs_route_data_previous`. After each renderer deploy, compare the
`PREVIOUS` rate per pool with the warm job's progress; a rate of zero with
cold pools means the previous keys changed shape.

Rollout: `shadow` for one renderer deploy with the warm job running, then
`on`. Revert: `DOXA_PROD_PREVIOUS_FALLBACK_MODE=off` and deploy
`docs-rendering`.

Entries stored before the ETag change have no ETag (FC-L7). If a probe starts
the revalidation of such an entry after its max-age (30 days), the refresh
gets the 204 marker and deletes the entry (F39). Expect this only during the
first deploy with the fallback enabled, and only for old keys. The effect is
one extra render on the next real request, not wrong content. Do not take an
early rise of `PREVIOUS` misses on old keys in that deploy as a fault. Entries
written after the ETag change are not affected.

## Regional warm job

M28 + M45 + M45b. After a publish or a renderer deploy, the dispatcher fills
every upper-tier pool (see [Cache Topology](#cache-topology)) with a site's
pages, so the first visitor in each region reads a HIT. It also writes the
[warm state](#warm-state) that the previous-build fallback reads. Code:
`apps/docs-dispatcher/src/warm/`. Spec: `research/docs-cache-2026-10-29/spec.md`
§ 7.

### Parts

| Part | What it does |
|---|---|
| Queue `doxa-docs-warm-publish` | Publish jobs. Consumer: batch 1, concurrency 5, 5 retries, 60 s retry delay, DLQ `doxa-docs-warm-dlq` |
| Queue `doxa-docs-warm-sweep` | Renderer-deploy jobs. Same settings, concurrency 2 |
| `DocsWarmLock` (one per site, `site:<siteId>`) | The running job, a `pendingTarget` (newest wins), per-pool progress, a 30-minute lease (each warmer alarm's heartbeat and each fill reservation renew it, never past 3 h after the job started), a 1-hour done record per target, the hourly fill budget, and the only writer of `warm:<siteId>` |
| `DocsWarmAnchor` (one per pool, `anchor:<pool>`, created with the pool's location hint) | Finds its own colo once (`https://<DOXA_DOCS_BASE_DOMAIN>/cdn-cgi/trace`, a Doxa host only) and creates the site's regional warmer. A misplaced anchor refuses work; the consumer tries `anchor:<pool>:2` and `:3` |
| `DocsRegionalWarmer` (one per pool and site, `warm:<pool>:<siteId>`, no hint) | Created by the anchor, so it runs in the anchor's pool. Fills in alarms |
| `DocsWarmControl` (`slots`, `sweep`) | The global cap on active warmers, and the deploy sweep cursor |
| Cron `*/5 * * * *` | One sweep tick |

Location hints (S1): us-west `wnam`, us-east `enam`, eu-west `weur`, eu-east
`eeur`, asia-ne `apac-ne`, hong-kong `apac`, singapore `apac-se`, oceania `oc`.
The colo table is `@doxahq/contracts/docs-warm-region`, shared with
`poolForRequest` and the API edge.

There is no public trigger. Producers: `DocsHostCache.syncHostnames` (publish)
and `scheduled()` (deploy). Messages carry IDs and ordering only
(`@doxahq/contracts/docs-warm-job`).

### Flow

```text
syncHostnames (API, after a publish commits)
  writes the map; for each hostname whose live resolution changed → group by site
  → one publish message per site { siteId, hostnames, releaseId, publishedVersionId,
    jobId, priority: the API's warm hint }  (a failed send is logged, the sync succeeds)

scheduled() every 5 min, only with DOXA_PROD_WARM_DEPLOY_SWEEP=on
  DocsWarmControl("sweep"): new release → reset cursor; KV.list("host:", cursor)
  → group by metadata.siteId (no metadata → get) → at most
    min(DOXA_WARM_SWEEP_SITES_PER_TICK, floor(free slots / pools)) sites → sweep queue

queue() consumer (both queues), never fills itself (F44)
  validate → site in the rollout → release = deployed release
  → re-read every hostname from KV; publish message not visible yet → retry 30 s
    (attempts 1–5; the 6th delivery uses what KV holds, F7)
  → keep fresh public production entries of this site (≤ DOXA_WARM_MAX_HOSTNAMES)
  → lock.submit: granted | continued → plan once (getPrerenderPlan) + navigation
    (getSections, getRoutes); pending | duplicate | done_recently | stale → ack
  → pages: home, hint paths in the plan (≤ 50), navigation, rest (≤ DOXA_WARM_MAX_PAGES)
  → pools: hint regions, then DOXA_WARM_POOLS → anchor.start(job) per pool → ack

regional warmer alarm
  slot from DocsWarmControl("slots") (denied → 30 s)
  superseded? (KV version changed, hostname removed, release changed, rollout off)
  M36 site: DOCS_RENDERED_BUCKET.head(manifest) (F21); not ready → 60 s, at most
    20 min, then the pool fails with prerender_not_ready
  fill ≤ 6 at a time, for ≤ 12 min, through selectPublicCacheCalls + ctx.exports
    (the visitor's exact keys, F5, F34); cancel the body after the headers (S2);
    a probe marker = not filled, retry once
  save the cursor, release the slot, re-arm
  after the last fill: probe ≤ 20 evenly spread keys (F41); misses → re-fill once,
    90 s later (a probe miss blocks stores of that key for over a minute, F38)
  report done | failed | superseded to the lock, deleteAll()

site lock
  pool done for the deployed release → warm:<siteId> (a new release replaces the
  record; writes are batched by an alarm, 1 per second per key in KV)
  every pool ended, or the lease ran out → job done; the pending message goes to
  the publish queue
```

Lease and failure rules:

- Every warmer alarm sends a heartbeat to the site lock, also while it waits
  for a slot or for saved output. The heartbeat renews the 30-minute lease
  while the job is the running one, but never past 3 h after the job started.
- `reserveFills` answers granted N, `budget_exhausted` (retry after 5 min), or
  `job_ended`. On `job_ended`, or a heartbeat that says the job is not the
  running one, the warmer deletes its state, reports nothing, and releases
  only the slot it holds for that run.
- On a lease takeover, the newer of the pending message and the incoming
  message (by `enqueuedAt`) runs, and the older one is dropped.
- If some map writes fail during `syncHostnames`, the warm job still starts
  for the hostnames that were written. The sync then fails, so the API
  retries the rest.
- `DocsWarmLock.alarm()` sets its next alarm directly: inside an alarm
  handler, `getAlarm()` returns null until the handler calls `setAlarm`.

A warmer never probes a key before it fills it (F38). Warm fills never use a
global `fetch` to a customer hostname.

### Limits and flags

| Variable | Values | Default |
|---|---|---|
| `DOXA_PROD_WARM_MODE`, `DOXA_PROD_WARM_SITE_IDS` | `off`, `allowlist`, `all` | `off`, empty |
| `DOXA_PROD_WARM_DEPLOY_SWEEP` | `off`, `on` | `off` |
| `DOXA_WARM_MAX_ACTIVE_WARMERS` | 1–500 warmers filling at once, all sites | `24` |
| `DOXA_WARM_MAX_ACTIVE_WARMERS_PER_SITE` | 1–500 warmers of one site filling at once | `4` |
| `DOXA_WARM_SWEEP_SITES_PER_TICK` | 1–5000; a tick also starts at most `floor(free slots / pools)` sites, because each site starts one warmer per pool | `200` |
| `DOXA_WARM_MAX_PAGES` | 1–2000 pages per site (D9) | `500` |
| `DOXA_WARM_MAX_HOSTNAMES` | 1–10 hostnames per site | `3` |
| `DOXA_WARM_SITE_FILLS_PER_HOUR` | fills per site per hour, all pools | `20000` |
| `DOXA_WARM_POOLS` | comma list of pools, in warm order | `us-east,eu-west,us-west,asia-ne,singapore,hong-kong,eu-east,oceania` |

An invalid value falls back to the default with a warning. The queue, Durable
Object, migration and cron settings are pinned by
`scripts/lib/dispatcher-warm-config.mjs`; migrations are append-only.

### Status (M45b)

`DocsHostCache.getWarmStatus({ siteId })` returns the latest job of the past
hour: `{ siteId, releaseId, startedAt, finishedAt, pools: [{ pool, state:
pending | running | done | failed, updatedAt }] }`, no content. The API calls
it through the bridge (`BRIDGE_CALL_BINDINGS.DOCS_CACHE_INVALIDATOR`) after it
checks that the signed-in user may read the project. The publish menu shows
the viewer's own pool as live (`done`), still warming, or "not pre-warmed"
(`failed`); a failed pool never reads as warming (FC-L9).

### Logs

| Event | Fields |
|---|---|
| `docs_hostname_map_sync` | `updates`, `liveChanges`, `warmHint`, `warmEnqueued`, `skipped` (only with the warm rollout on) |
| `docs_warm_job` | `jobId`, `siteId`, `reason`, `releaseId`, `hostnames`, `attempts`, `queuedMs`, `action` (`ack`, `retry`), `outcome` |
| `docs_warm_lock` | `action` (`submit`, `report`, `finish`, `warm_state_written`, `start_pending`), `state` |
| `docs_warm_anchor` | `pool`, `colo`, `placement`, `misplaced` |
| `docs_warm_region` | per pool: `outcome` (`done`, `failed`, `superseded`, `continued`), `reason`, counts (`filled`, `notFilled`, `errors`, `verified`, `verifyMisses`, `refilled`), `durationMs` |
| `docs_warm_slots` | every grant and release, expiries, and 1 in 20 denials with a `denials` count and `reason` (`global_cap`, `site_cap`) |
| `docs_warm_sweep` | `releaseId`, `reset`, `enqueued`, `total`, `free`, `cursorDone`, `listMs` |

### Rollout and rollback

1. Create the queues (the deploy preflight in `deploy-renderer.mjs` refuses to
   deploy without them and prints the commands):
   `wrangler queues create doxa-docs-warm-dlq`, `doxa-docs-warm-publish`,
   `doxa-docs-warm-sweep`. Add an alert on the DLQ depth (F36).
2. Deploy the code with `DOXA_PROD_WARM_MODE=off`. **The Durable Object
   migration `v1` happens here and is permanent**; the queue bindings and the
   cron start too (they do nothing while the mode is `off`).
3. `allowlist` with the canary sites; publish and check `docs_warm_job`,
   `docs_warm_region` and the next visit's `x-doxa-html-cache: HIT`.
4. `DOXA_PROD_WARM_DEPLOY_SWEEP=on`, one renderer deploy, then `all`.

Deploy `docs-rendering` before the API that sends `warm` hints: an older
dispatcher's strict sync schema rejects the field. If the order is wrong, the
API sends a failed batch once more without `warm`
(`docs_hostname_map_sync_retry_without_warm`), so the hostname map is fresh
at once and only that publish's warm hint is lost (FC-M3).

Rollback is a forward deploy with `DOXA_PROD_WARM_MODE=off`: the consumer acks
and drops, running warmers stop at their next check (`rollout_off`), and the
sweep stops. Never remove the classes or the migration; deleting a Durable
Object class needs a `deleted_classes` migration.

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
- Any authorization, range, upgrade, cache-control, or pragma header bypasses
  the HTML cache. A browser reload can therefore bypass HTML caching. A cookie
  does not: every shared cache also requires a public production site, and the
  renderer reads cookies only in the access gate of generation previews. So an
  analytics cookie of a parent domain, which the browser also sends to a docs
  subdomain, keeps the cache (RES-1). Route data follows the same rule.
  Every request resolves its hostname through `DocsHostCache`, also a
  visitor-specific request. The resolution depends only on the hostname, and only public
  production mappings are stored. A reload therefore does not bypass the
  hostname mapping; freshness after a publish depends on the purge.
- Any query string bypasses caching, including demo and framework data requests.
- The renderer's own server routes (`/api/search` and `/api/echo/...`, listed
  in `RENDERER_API_ROUTES`), underscore-prefixed routes, dotted paths such as
  assets and markdown, and malformed/unsafe encoded paths bypass the HTML
  cache. Other `/api/...` paths are docs pages and use the cache (RES-2). A
  test fails when a new `api.*` route file in docs-template is not listed. The text
  routes have their own entrypoint (see [Text routes](#text-routes)).
- Unknown hosts, private resolutions, previews, and permanent generation URLs
  are not stored in the hostname cache. They cannot use the HTML cache.
- Only HTTP 200 HTML without `Set-Cookie`, `Vary`, or explicit private/no-cache/
  no-store directives can be stored by the HTML entrypoint.
- Renderer errors and redirects are not cached. Existing safe shared-renderer
  fallback remains available and is never stored under a pinned version's key.
- Dynamic mode `off` bypasses hostname resolution and both cache entrypoints.

Fingerprint-named static assets served directly by the existing Workers Assets
binding keep their existing behavior. Old client files of earlier builds are
served from R2 (see [Old client assets](#old-client-assets)). Local `.localhost` development is outside
this HTML cache. No preview access rules or dashboard code were changed.

## Inbound Internal Headers

Internal entrypoints trust some `x-doxa-*` request headers, for example
`x-doxa-internal-render-id` on an HTML cache fill. A visitor must not set
them. So the first step of the dispatcher `fetch` removes every request header
whose name starts with `x-doxa-`, before any routing
(`apps/docs-dispatcher/src/inbound-headers.ts`, called from `edge-gateway.ts`).
After that step, only the dispatcher sets internal headers.

The strip has no exceptions. No external client sends an `x-doxa-*` header to
a docs hostname:

- The API health check of a custom domain reads `x-doxa-renderer-health` from
  the response. It sends no `x-doxa-*` header.
- `x-doxa-host` and `x-doxa-project-id` go only from docs-template to the
  docs-runtime HTTP route, never to a docs hostname.
- Preview, private and generation hosts use no `x-doxa-*` request header.

If a later feature needs a visitor-sent `x-doxa-*` header, validate it and add
it to this list.

## HTTP to HTTPS

`DOXA_PROD_HTTPS_REDIRECT_MODE` is `off` or `on`. An invalid value means `off`
and logs a warning. `pnpm validate:production-config` rejects an invalid value.
The committed value is `off`.

With `on`, the dispatcher does two things (`https-policy.ts`):

1. It redirects every plain-HTTP request to the same URL over HTTPS, with the
   same path and query. `GET` and `HEAD` get 301. Other methods get 308, which
   keeps the method and the body. The response has
   `cache-control: public, max-age=3600`. The target host is the request
   host, so the redirect cannot send a visitor to another site.
2. It adds `strict-transport-security: max-age=86400` to every HTTPS response
   that it returns. There is no `includeSubDomains` and no `preload`.

Two paths never redirect, because certificate validation reads them over
plain HTTP: `/.well-known/acme-challenge/` and
`/.well-known/cf-custom-hostname-challenge/`.

About one redirect in 100 writes a `docs_https_redirect` log line with the
hostname, method and status. The line has no path.

Static files that Workers Assets serves never run the Worker. They get no
redirect and no HSTS from the dispatcher. A `_headers` file in
`apps/docs-template/dist/client` gives them HSTS; it is part of the
docs-template build.

Tell customers before the flag goes `on`: a browser keeps a 301 for a long
time, and HSTS on a custom domain stays in the browser after the domain leaves
Doxa (1 day now, maybe 1 year later).

To revert, set the mode to `off` and deploy the `docs-rendering` step. Browsers
that saw HSTS keep it for one day.

## Route Data in the Browser Cache

The client asks for route data at
`/_doxa/route-data/v1?path=<path>&render=<renderId>`. When the `render` hint
equals the live render ID, the answer for that URL cannot change: a new
publish or renderer release changes the render ID, and so the URL.

`handleRouteDataEndpoint` returns `hintMatched`. The gateway sets
`cache-control: private, max-age=3600` only when all of these are true
(`route-data-browser-cache.ts`):

- The status is 200.
- The hint matched.
- The request has no cookie and no authorization header.
- The site is public production.
- The rollout includes the site.

All other answers keep `private, no-store`. The two CDN headers always stay
`private, no-store`, so no shared cache stores the answer.

The rollout uses two dispatcher variables:

- `DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_MODE`: `off`, `allowlist` or `all`.
  Unset or invalid means `off` (an invalid value logs a warning).
  `pnpm validate:production-config` rejects an invalid value. The committed
  value is `off`.
- `DOXA_PROD_ROUTE_DATA_BROWSER_CACHE_SITE_IDS`: comma-separated site IDs for
  `allowlist`.

A browser that has an answer keeps it for up to one hour, also after a
takedown, but only for the old render ID. A new page load gets the new render
ID. To revert, set the mode to `off` and deploy the `docs-rendering` step.
Answers already in browsers stay there for up to one hour.

## Renderer Release Checks

`DocsRouteDataCache` and `DocsPrerenderCache` key their entries on the
delivery identity, which contains the renderer release. A call for another
release would render with the deployed build and store the result under the
other release's key. So both entrypoints reject a call whose
`expected.rendererReleaseId` is not the deployed `DOXA_RENDERER_RELEASE_ID`.
They also reject every call while the release is not set. The answer is
HTTP 400 with `private, no-store`, and one `docs_cache_release_rejected` log
line with the entrypoint, the reason and both release IDs. `DocsHtmlCache`
already rejects a call for another build in the same way.

The check is `checkRendererRelease` in `release-check.ts`. It accepts one extra
release only when the caller names it (`alsoAcceptReleaseId`). Only a cache
probe of the previous release may use it.

### Text routes

`DocsTextCache` (`text-cache-entrypoint.ts`, `text-cache-policy.ts`) stores
`/llms.txt`, `/llms-full.txt`, `/sitemap.xml`, `/robots.txt` and the raw
Markdown of a page at `/{path}.md` for public production sites in the `DOXA_PROD_TEXT_ROUTE_CACHE_MODE` rollout
(`off|allowlist|all`, site IDs in `DOXA_PROD_TEXT_ROUTE_CACHE_SITE_IDS`; default
`off`). `DocsHtmlCache` cannot serve them: it requires an HTML `accept` and an
HTML response, and a new HTML prop would change every HTML key.

- The visitor request must be HTTPS `GET` or `HEAD`. For a public production
  site a query string, a `Cookie`, an `Authorization` or a `Range` header does
  not bypass the cache: the responses depend only on the host and the path,
  and the cache sees only the canonical request. A `Range` is ignored; the
  visitor gets the full 200. Private and preview sites render uncached, so
  the access gate still sees the cookie. The `.md` path has segments from
  `[A-Za-z0-9_-]` and one `.md` suffix: no `%`, `..`, dot segment, segment
  starting with `_`, and not a renderer server route (`RENDERER_API_ROUTES`).
- `/sitemap.xml` and `/robots.txt` are per site and per hostname (RES-7): the
  sitemap lists the linked pages of the visible sections on the request origin,
  and `robots.txt` names that sitemap. The platform renderer build ships no
  static `sitemap.xml`, which Workers Assets would serve first.
- Canonical links use the requesting hostname: `toHostResolution` sets
  `siteUrl` (`https://{hostname}`) on the pinned resolution, the pre-renderer
  sets it from the task's `trustedRequestOrigin`, and docs-runtime makes it
  the site URL. `DOCS_PUBLIC_BASE_URL` is only the fallback for calls without
  a resolved hostname.
- The dispatcher builds the cache request from scratch: always `GET`, only
  `accept: */*`, no query. A visitor `HEAD` gets the stored response without a
  body.
- The entrypoint checks the request shape, the route allowlist, the hostname,
  public production and the deployed renderer build before it renders.
- Only a 200 with the exact content type of the route is stored: `text/plain`
  for the llms routes, `text/markdown` for `.md`. Everything else is
  `no-store`, also `text/html` (an `.md` path with raw Markdown off falls
  through to the HTML pages).
- Each request logs one `docs_text_cache` line (`hostname`, `siteId`, `route`,
  `status`, `cacheStatus`), and the response has `x-doxa-text-cache`.

### Old client assets

A page loaded before a renderer deploy still asks for the hashed client files
of its build. The static `ASSETS` binding only has the new files, so the
request reaches the Worker. With `DOXA_PROD_CLIENT_ASSET_FALLBACK_MODE=on`
(`off|on`, default `off`), `client-asset-fallback.ts` serves a `GET` or `HEAD`
for `^/assets/(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9._-]{0,119}-[A-Za-z0-9_-]{8}\.(js|css)$`
from `DocsClientAssetCache` before any host lookup. Customer images under
`/assets/` never match and still go to the version assets.

- `DocsClientAssetCache` reads only `client-assets/v1/assets/{file}` from the
  renderer code bucket, at the fixed URL `https://client-assets.internal/v1/{file}`.
- A hit returns 200 with headers from an allowlist only: `content-type` by
  extension (`text/javascript` or `text/css`, `charset=utf-8`),
  `x-content-type-options: nosniff` and
  `cache-control: public, max-age=31536000, immutable`. R2 metadata is never
  copied. A miss returns 404 with `public, max-age=60`.
- Every renderer deploy uploads all files of `apps/docs-template/dist/client/assets/`
  (see [Docs content injection](production-docs-content-injection.md#old-client-assets)).
  A 30-day lifecycle rule on the prefix `client-assets/` deletes them.
- Each request logs one `docs_client_asset_fallback` line (`file`, `status`,
  `cacheStatus`).

Turn the mode `on` only after the second renderer deploy with the upload, so
that the previous build's files are in the bucket.

## Verification and Operations

Every request writes one `docs_request_cache` log line with the hostname,
path, status, cache statuses, data center (`colo`) and, once the hostname is
resolved, `hostSource` and `hostnameMap` (see [Hostname Map](#hostname-map)). With `DEBUG` set to
`true`, the line is `docs_request_timing` and also carries the timings. Every
renderer call writes `docs_renderer_load` with the isolate scope, the build,
`COLD` (this request started the isolate) or `WARM`, the code load time and
its source (`memory`, `cache` or `r2`), the total time and the outcome (see
[Renderer Isolate Scope](./production-docs-content-injection.md#renderer-isolate-scope)).
docs-runtime writes `docs_runtime_reads` for every
`getRouteData` call (a cold render whose
[route-data prefetch](./production-docs-content-injection.md#route-data-prefetch)
was not handed off makes two), with the number of artifact reads that passed the memory
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
`exports.DocsHtmlCache.cache.enabled`,
`exports.DocsRouteDataCache.cache.enabled` and
`exports.DocsRendererCodeCache.cache.enabled` to `false`, then redeploy through the same
workflow. To stop caching text routes or serving old client assets, set
`DOXA_PROD_TEXT_ROUTE_CACHE_MODE` or `DOXA_PROD_CLIENT_ASSET_FALLBACK_MODE` to
`off` and redeploy. Without the renderer code cache, every cold renderer start in a new
dispatcher isolate reads the package from R2 again (`codeSource: "r2"`). The global `cache.enabled` is already `false`; it does not override
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
