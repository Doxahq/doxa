# Production docs client-navigation cache

Status: implemented on 2026-10-01. Not deployed.
Date: 2026-10-01.
Decision: lazy, version-keyed route-data cache (A), hostname cache for every
request plus a navigation progress bar (C), and stale-while-revalidate for
version-keyed cache entries.

Implementation must follow the clean-code skill `/i-coderone-clean-code`
(`~/.claude/skills/i-coderone-clean-code/SKILL.md`) and the repository
`AGENTS.md`. Section 5 lists the concrete clean-code requirements for this
change.

This spec does not authorize a commit, a deployment, a Wrangler production
config change, or a change to an existing test assertion. Section 9 lists the
items that need explicit approval.

## 1. Goal

Make client navigation on public production docs as fast as a cached full page
load. One visitor pays the server render cost for a page and version. All later
visitors, in all regions, get the cached result until the next publish.

This matches the Mintlify / Vercel ISR model: render on first request, share the
result globally, and invalidate on publish.

### The problem today

Production runs with `DOXA_PROD_PRERENDER_MODE=off`
(`apps/docs-dispatcher/wrangler.json`). In this mode:

1. `getActivePrerenderIdentity` returns `null`. The dispatcher sends no
   `x-doxa-internal-render-id` header to the renderer.
2. The page gets no `window.__DOXA_DOCS_DELIVERY__`.
3. `loadDocsRouteDataForNavigation`
   (`apps/docs-template/src/runtime/runtime-route-data.ts`) falls back to the
   TanStack server function `loadDocsRouteData` (`GET /_serverFn/...?payload=`).
4. The dispatcher classifies this request as not cacheable. `resolveHost` then
   skips `DocsHostCache` and calls the API resolver, which reads Postgres.
5. The Dynamic Worker reads R2 and runs MDX parse and Shiki highlight
   (`route.parseRuntimeDocument`) on every click.
6. Nothing stores the result. The user sees no feedback for about 2 seconds.

### What already exists

- `/_doxa/route-data/v1` (`apps/docs-dispatcher/src/prerender-routing.ts`)
  returns route data in a versioned envelope, keyed by `renderId`.
- `PrerenderRendererApi.prepare` calls the renderer's private
  `DocsPrerenderRenderer.prepare` entrypoint. It returns the same
  `PublicDocsRouteDataV1` DTO that the HTML render uses.
- The client calls the endpoint when `__DOXA_DOCS_DELIVERY__` exists. On 404 or
  503 it falls back to the server function. On 409 it does a full page load.
- Workers Cache is tiered and global. The first fill anywhere populates an upper
  tier that every data center reads on a miss. Purge propagates globally.

So the renderer and the client need no new data path. The dispatcher must issue
the delivery capability and cache live route data without the pre-render
feature.

## 2. Scope

### In scope

- **A1.** Separate the delivery identity (`renderId`) from the pre-render
  rollout. Issue it for public production sites in a new rollout setting.
- **A2.** A new `DocsRouteDataCache` Workers Cache entrypoint that stores live
  route data per host, `renderId`, and path.
- **A3.** Add the delivery `renderId` to the `DocsHtmlCache` key, because the
  HTML now embeds it.
- **A4.** A new rollout setting: `DOXA_PROD_ROUTE_DATA_CACHE_MODE` and
  `DOXA_PROD_ROUTE_DATA_CACHE_SITE_IDS`.
- **SWR.** Version-keyed cache entries use `stale-while-revalidate` and
  `stale-if-error`. They no longer use `must-revalidate`.
- **C1.** Every dispatcher request resolves the hostname through
  `DocsHostCache`.
- **C2.** A navigation progress bar in the docs renderer.
- Tests, config validation, and documentation updates for each item.

### Out of scope

- Pre-render output in R2 (option B). The pre-render path stays as it is,
  including its 30-second live fallback lifetime.
- Previews, private sites, permanent generation URLs, and `.localhost` dev.
  These keep the server-function path.
- Cache for chat, search, raw Markdown, or other server functions.
- Browser or public HTTP caching. Public responses stay `private, no-store`.
- Any change to `PublicDocsRouteDataV1`, the envelope schema, or artifact
  schemas.
- TanStack `pendingComponent` or `defaultPendingMs`. The old page stays on
  screen during navigation.
- Request coalescing for concurrent cold misses.

## 3. Constraints

- **Tenant isolation.** The dispatcher computes `renderId` from the trusted
  host resolution only. The browser `render` query value is a hint for a
  mismatch check. It never selects data.
- **Immutable keys.** Every input to a version-keyed entry must be part of its
  cache identity. A publish must select a new key. It must never change content
  under an existing key.
- **Compatibility contract.** C2 touches `apps/docs-template`. Run the three
  compatibility suites (section 8). Do not edit
  `packages/docs-artifact-fixtures/sets/`.
- **Public responses.** The public dispatcher response keeps
  `private, no-store` on all three cache headers.
- **No per-site renderer pin.** Do not store a build or release ID on a
  published version.
- **Existing behavior.** If the new rollout setting is `off`, client navigation
  works exactly as today. Only SWR, C1, A3, and C2 change behavior in that
  state.

## 4. Design

### 4.1 Delivery selection (A1, A4)

The dispatcher reads two site rollouts from env:

| Setting pair                                  | Meaning                                 |
| --------------------------------------------- | --------------------------------------- |
| `DOXA_PROD_PRERENDER_MODE` / `_SITE_IDS`      | Saved R2 output (existing)              |
| `DOXA_PROD_ROUTE_DATA_CACHE_MODE` / `_SITE_IDS` | Lazy route-data cache (new)           |

Each mode accepts `off`, `allowlist`, or `all`. An invalid value disables the
rollout and logs one warning, the same as `parsePrerenderMode` today.

For one public production resolution, the route-data delivery is:

| Pre-render includes site | Route-data cache includes site | Delivery       |
| ------------------------ | ------------------------------ | -------------- |
| yes                      | any                            | `saved`        |
| no                       | yes                            | `cachedLive`   |
| no                       | no                             | none           |

The delivery identity is the existing `PrerenderIdentity`. Create it only when
all of these are true:

- The delivery is not none.
- The resolution is public production (`isPublicProduction`).
- `DOXA_RENDERER_RELEASE_ID` is a 64-character hex value.
- The request is HTTPS and its hostname equals `resolution.hostname`.

If an identity exists, the dispatcher sends `x-doxa-internal-render-id` to the
renderer for HTML requests. The renderer already turns this header into
`window.__DOXA_DOCS_DELIVERY__`. No renderer change is necessary for A.

`tryPrerenderedHtml` uses the identity only when the delivery is `saved`.

### 4.2 Route-data endpoint flow (A2)

```text
GET /_doxa/route-data/v1?path=/guide&render=<hint>
  → parseRouteDataRequest (unchanged)
  → resolveHost through DocsHostCache
  → selectRouteDataDelivery + createDeliveryIdentity
      none                → 404 { status: "unavailable", retryable }
  → hint !== identity.renderId → 409 { status: "version_mismatch" }
  → source:
      saved      + shared-cache eligible + bucket → DocsPrerenderCache  (existing)
      cachedLive + shared-cache eligible          → DocsRouteDataCache  (new)
      otherwise (cookie or authorization present) → live prepare, not stored
  → one envelope builder → private, no-store public response
```

Keep the current 404 `retryable` values. The rollout excludes the site:
`retryable: true`. No identity: `retryable: false`. The client treats both as a
fallback signal.

### 4.3 `DocsRouteDataCache` entrypoint (A2)

Props, all set by the dispatcher:

```ts
interface RouteDataCacheProps {
  expected: PrerenderIdentity;
  hostname: string;
  pathname: string;
  resolution: DocsDomainResolution;
}
```

Request URL: `${origin}${ROUTE_DATA_PATH}${pathname}`, method `GET`,
`accept: application/json` only. The URL space must stay separate from HTML.

Before it renders, the entrypoint must reject the request with HTTP 400 and
`private, no-store` if any of these is true:

- The route-data cache rollout in its own env does not include the site.
- The resolution is not public production.
- `hostname`, `resolution.hostname`, and the request URL hostname differ.
- `expected.siteId !== resolution.siteId`.
- `expected.trustedRequestOrigin` differs from the request origin.
- The request path is not `ROUTE_DATA_PATH + pathname`.

On success it calls `PrerenderRendererApi.prepare`. It returns the parsed
`PublicDocsRouteDataV1` as JSON with the `versioned` lifetime (4.5) and
`x-doxa-representation-source: dynamic`.

If `prepare` throws, it returns 503 with `private, no-store`. One example is an
MDX parse failure, which `preparePublicDocsRouteData` rejects. The client then
uses the server function, which renders the error state.

A `not_found` or `redirect` route-data result is a valid, immutable value for
that key. Store it like a page.

Add the export to `apps/docs-dispatcher/wrangler.json`:

```json
"DocsRouteDataCache": { "type": "worker", "cache": { "enabled": true } }
```

### 4.4 HTML cache key (A3)

`HtmlCacheProps` gains `deliveryRenderId: string | null`. This value is the
identity `renderId` that the dispatcher sends to the renderer.

Reason: the build ID does not change when only client assets change, but the
release ID and `renderId` do (`production-docs-content-injection.md`, "What
changes what"). Cached HTML embeds the `renderId` and the asset links, so the
key must include it. Cloudflare also separates cache by deployed Worker version.
This prop makes the rule explicit, so it does not depend on that platform
default.

`DocsHtmlCache` rejects a request whose `x-doxa-internal-render-id` header
differs from `deliveryRenderId`. A missing header must equal `null`.

### 4.5 Cache lifetimes (SWR)

Replace numeric TTL parameters (`ttlSeconds: 30 | 86_400`) with named
lifetimes:

```ts
export type DocsCacheLifetime = "hostname" | "versioned" | "liveFallback";

export const DOCS_CACHE_POLICY = {
  hostnameTtlSeconds: 3_600,
  versionedTtlSeconds: 86_400,
  versionedStaleSeconds: 604_800,
  liveFallbackTtlSeconds: 30,
} as const;
```

| Lifetime       | Used by                                                    | `Cache-Control`                                                                 |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `hostname`     | `DocsHostCache`                                            | `public, max-age=3600, must-revalidate` (unchanged)                             |
| `liveFallback` | `DocsHtmlCache` and `DocsPrerenderCache` live fallback     | `public, max-age=30, must-revalidate` (unchanged)                               |
| `versioned`    | `DocsHtmlCache`, saved HTML, saved data, `DocsRouteDataCache` | `public, max-age=86400, stale-while-revalidate=604800, stale-if-error=604800` |

Rules:

- `hostname` must keep `must-revalidate`. A stale mapping points to an old
  version after a publish.
- `liveFallback` must keep `must-revalidate`. Its purpose is fast replacement
  by repaired saved output.
- `versioned` must not contain `must-revalidate`, `s-maxage`, or
  `proxy-revalidate`. Cloudflare disables stale serving if one of them is
  present.
- Set the same value on `Cache-Control`, `CDN-Cache-Control`, and
  `Cloudflare-CDN-Cache-Control`, as today.

`HtmlCacheProps.ttlSeconds` becomes `lifetime: "versioned" | "liveFallback"`.

### 4.6 Hostname cache for every request (C1)

`resolveHost` in `apps/docs-dispatcher/src/index.ts` always uses
`DocsHostCache`. Remove the `!cacheable && !isRouteDataEndpoint` branch.

This is safe for these reasons:

- `resolveDocsHost` takes only the hostname. Cookies and headers do not change
  the result.
- `withHostCachePolicy` stores only public production resolutions. Previews,
  private sites, and unknown hosts stay `no-store`.
- Publish and domain changes already purge the hostname entry by tag.

Accepted change: a browser reload no longer bypasses the hostname mapping. It
still bypasses `DocsHtmlCache`. Freshness after a publish depends on the purge,
with the existing one-hour fallback.

Effect: search, chat, raw Markdown, and fallback server-function requests no
longer read Postgres for each call.

### 4.7 Navigation progress bar (C2)

- New hook `apps/docs-template/src/hooks/use-delayed-flag.ts`:
  `useDelayedFlag(active: boolean, delayMs: number): boolean`. It returns
  `true` only after `active` stays `true` for `delayMs`. It returns `false` at
  once when `active` becomes `false`. It clears its timer on unmount.
- New component
  `apps/docs-template/src/components/navigation/navigation-progress.tsx`:
  - Reads `useRouterState({ select: (state) => state.status === "pending" })`.
    Router preloads do not change `status`, so hover preloads do not show the
    bar.
  - Shows the bar after `NAVIGATION_PROGRESS_DELAY_MS = 150`. A cached
    navigation finishes before the bar appears.
  - Fixed, full width, 2px high, top of the viewport, above the navbar.
  - Color `bg-primary`, so it follows the site theme.
  - Indeterminate CSS animation in `src/styles/globals.css`. With
    `prefers-reduced-motion: reduce`, it shows a static bar.
  - `role="progressbar"` and `aria-label="Loading page"` only while visible.
    Otherwise it renders `null`.
- Mount it once in `src/routes/__root.tsx`, inside `SiteConfigProvider`, before
  `<Navbar />`.
- On a version mismatch, the loader never resolves and the browser does a full
  page load. The bar stays visible until the page unloads. This is correct.

### 4.8 Diagnostics

- The route-data endpoint sets `x-doxa-route-data-cache` on every response. The
  value is the `cf-cache-status` of the entrypoint that it used, or `BYPASS`.
  This matches `x-doxa-html-cache`.
- `logRequestTiming` receives the route-data cache status in place of a fixed
  `BYPASS` for this endpoint.

## 5. Module boundaries and clean-code requirements

Follow `/i-coderone-clean-code`. Concrete rules for this change:

- No `any`. No `as` cast to silence the compiler. The only accepted cast is the
  existing `ctx.exports` access, which the installed `workers-types` does not
  type. Section 5.2 moves it to one place.
- One responsibility per module. `index.ts` (701 lines) must get smaller, not
  larger.
- Extract code that now exists three times. Do not extract code that exists
  two times.
- Use named types for each concept: `SiteRollout`, `RouteDataDelivery`,
  `DocsCacheLifetime`, `RouteDataCacheProps`.
- Export only what another module imports.
- Refactors keep behavior. Existing tests must pass without changes to their
  assertions, except the assertions in section 9.

### 5.1 Dispatcher modules

| Module (under `apps/docs-dispatcher/src/`) | Status | Responsibility |
| --- | --- | --- |
| `rollout-policy.ts` | new | `RolloutMode`, `SiteRollout`, `parseSiteRollout`, `isSiteInRollout`. `parseSiteAllowlist` moves here from `routing-policy.ts`. |
| `routing-policy.ts` | changed | Renderer selection only. `parseRendererMode` uses `parseSiteRollout` without a warning, to keep its silent behavior. |
| `prerender-policy.ts` | changed | `parsePrerenderMode` uses `parseSiteRollout`. `createExpectedPrerenderIdentity` stays. |
| `delivery-identity.ts` | new | `readDeliveryRollouts(env)`, `selectRouteDataDelivery`, `createDeliveryIdentity`. This moves the body of `getActivePrerenderIdentity`, without the mode check. |
| `host-resolution.ts` | new | `toHostResolution`, now copied in `index.ts`, `prerender-routing.ts`, and `prerender-cache-entrypoint.ts`. |
| `worker-exports.ts` | new | One `DispatcherExports` interface and one `getWorkerExports(ctx)`. It replaces `getDispatcherExports`, `getPrerenderRoutingExports`, and `getPrerenderCacheExports`. |
| `live-route-data.ts` | new | `createLiveRouteDataResponse(ctx, resolution, pathname, lifetime)`. `DocsPrerenderCache` (live fallback) and `DocsRouteDataCache` both use it. |
| `route-data-cache-entrypoint.ts` | new | `DocsRouteDataCache` (4.3). |
| `route-data-endpoint.ts` | new | `handleRouteDataEndpoint` moves here from `prerender-routing.ts`, with one envelope builder for all sources (4.2). |
| `prerender-routing.ts` | changed | Saved HTML lookup and diagnostics only. |
| `cache-policy.ts` | changed | `DocsCacheLifetime`, `cacheControlFor(lifetime)`, `HtmlCacheProps` changes (4.4, 4.5). |
| `index.ts` | changed | Wiring only: C1, identity header, HTML props, export of the new entrypoint. |

### 5.2 Renderer modules

| Module (under `apps/docs-template/src/`) | Status | Responsibility |
| --- | --- | --- |
| `hooks/use-delayed-flag.ts` | new | Generic delayed boolean (4.7). |
| `components/navigation/navigation-progress.tsx` | new | Progress bar (4.7). |
| `routes/__root.tsx` | changed | Mounts the bar. |
| `styles/globals.css` | changed | Progress keyframes and reduced-motion rule. |

### 5.3 Config and scripts

| File | Change |
| --- | --- |
| `apps/docs-dispatcher/wrangler.json` | `DocsRouteDataCache` export with cache enabled. New vars, both `off` / empty. |
| `apps/docs-dispatcher/scripts/package-renderer.mjs` | Keep the new export and vars in the generated deploy config. |
| `scripts/validate-production-config.mjs` | Require `DocsRouteDataCache` cache enabled. Require a valid route-data cache mode. |

## 6. Edge cases

| Case | Behavior |
| --- | --- |
| Publish while a tab is open | Next click: endpoint computes a new `renderId` and returns 409. The client does a full page load to the destination. |
| Purge fails | Old mapping lives up to one hour, as for HTML today. Endpoint and HTML stay consistent with each other. |
| Renderer deploy | New release, so new `renderId`. Each open tab does one full page load on its next click. |
| Hover preload with a mismatch | No reload. `startVersionMismatchNavigation` ignores preloads. |
| Cookie or authorization on the endpoint | Live prepare, not stored. The client sends `credentials: "omit"`, so this is rare. |
| MDX parse failure | 503, not stored. Client falls back to the server function. |
| Unknown path | `not_found` data is stored for that key. Cost per new path is one prepare, the same as today. |
| Preview, private, unknown host, `.localhost` | No identity, so no capability. Server-function path as today. |
| `DOXA_RENDERER_RELEASE_ID` invalid | No identity. One warning. Server-function path. |
| Concurrent cold misses on one key | Can run `prepare` more than once. Accepted. |
| Rollout set to `off` after use | Endpoint returns 404. The client falls back. Cached HTML from the previous Worker version is not served after the deploy. |

## 7. Acceptance criteria

With `DOXA_PROD_ROUTE_DATA_CACHE_MODE` enabled for a public production site:

1. The HTML contains `window.__DOXA_DOCS_DELIVERY__` with a 64-character
   `renderId`.
2. A click on a docs link requests `/_doxa/route-data/v1?path=...&render=...`.
   It does not request `/_serverFn/`.
3. The first request for a page returns `x-doxa-route-data-cache: MISS`. A
   second request from a different browser profile returns `HIT`.
4. A warm click is not slower than a warm full page load from `DocsHtmlCache`
   for the same page. Record both timings.
5. After a publish, the next click in an old tab does a full page load and
   shows the new content.
6. Cached HTML and route-data entries carry the `versioned` header from 4.5.
   The hostname and live-fallback entries keep their current header.

With the rollout `off`, and for previews and `.localhost`:

7. Client navigation uses the server function, as today.
8. Non-HTML dispatcher requests show `x-doxa-host-cache` other than `BYPASS`.
9. The progress bar appears for a navigation that takes longer than 150 ms. It
   does not appear for a hover preload or a fast navigation.

All of these pass: section 8 commands, the three compatibility suites, and
both typechecks.

## 8. Verification

### Local commands

```bash
pnpm --filter @doxahq/docs-dispatcher typecheck
pnpm --filter @doxahq/docs-dispatcher test
pnpm --filter @doxahq/docs-template typecheck
pnpm --filter @doxahq/docs-artifact-fixtures test
pnpm --filter @doxahq/docs-runtime test
pnpm --filter @doxahq/docs-template test
```

Also run the `scripts/validate-production-config` tests and the
`package-renderer` script tests.

### New and extended tests (dispatcher)

- `rollout-policy.test.ts` (new): mode parse, invalid value warns once,
  allowlist membership.
- `delivery-identity.test.ts` (new): the selection table in 4.1. Identity is
  `null` for preview, private, non-HTTPS, host mismatch, and invalid release ID.
- `route-data-endpoint.test.ts` (new): `cachedLive` calls `DocsRouteDataCache`
  with the exact props and URL. Cookie gives a live, unstored result. Hint
  mismatch gives 409. Prepare failure gives 503 `no-store`. HEAD works. The
  envelope is identical for `saved`, `cachedLive`, and live sources.
- `cache-entrypoints.test.ts`: each `DocsRouteDataCache` rejection rule in 4.3
  returns 400 `no-store`. Success uses `versioned`. `DocsHtmlCache` rejects a
  `deliveryRenderId` mismatch.
- `cache-policy.test.ts`: exact header per lifetime. `versioned` contains no
  `must-revalidate`, `s-maxage`, or `proxy-revalidate`.
- `index.test.ts`: with the rollout on, the renderer receives
  `x-doxa-internal-render-id` and `HtmlCacheProps.deliveryRenderId` is set.
  A cookie request and a `/_serverFn/` request resolve through `DocsHostCache`.
- `package-renderer.test.mjs` and `validate-production-config.test.mjs`: new
  export and vars.

### Renderer

- The template uses a Node test environment with no React render tests. Check
  C2 in a browser on `:3002`. Throttle the network to "Slow 4G", click a link,
  and make sure that the bar appears and then hides. Hover a link and make sure
  that no bar appears.
- If the renderer returns 500 after an edit during `pnpm dev`, restart the dev
  server.

### After an approved deployment

1. Load a page and read `window.__DOXA_DOCS_DELIVERY__`.
2. Click a link two times from two browser profiles. Record
   `x-doxa-route-data-cache` and timings.
3. Publish a change from the editor. Click in the old tab. Make sure that the
   new content appears after the full page load.
4. Load a preview host. Make sure that it has no capability.

## 9. Items that need explicit approval

- Changes to `apps/docs-dispatcher/wrangler.json` (production Wrangler config).
- Changes to `scripts/validate-production-config.mjs`.
- These existing test assertions change from the `must-revalidate` form to the
  `versioned` form in 4.5:
  - `apps/docs-dispatcher/tests/cache-policy.test.ts:196`
  - `apps/docs-dispatcher/tests/cache-entrypoints.test.ts:154`
  - Any test that builds `HtmlCacheProps` with `ttlSeconds`. These change to
    `lifetime` and `deliveryRenderId`. Coverage stays the same.
- Each deployment, and each rollout step in section 10.
- The commit.

## 10. Rollout

Decision on 2026-10-01: the default is `all` everywhere (dispatcher config,
package script, deploy script), and the production config check enforces it.
Every deployment enables the feature for every public production site.

1. Deploy through `pnpm deploy:docs-template`. All changes take effect.
2. Run the checks in section 8 against one production site.
3. If a check fails, deploy again with `--route-data-cache-mode off`.

Rollback: set the mode to `off` and redeploy. Pages keep their render path.
Clients without a capability use the server function. Nothing needs a purge.

## 11. Documentation updates

- `docs/current/production-docs-caching.md`: hostname cache for every request
  (C1), lifetimes and SWR (4.5), the `DocsRouteDataCache` layer and its key,
  and the new `deliveryRenderId` part of the HTML key.
- `docs/current/production-docs-prerendering.md`: the route-data endpoint now
  works without pre-render, and `saved` has priority over `cachedLive`.
- `docs/current/production-docs-content-injection.md`: the HTML cache identity
  includes the delivery `renderId`.

## 12. Implementation checkpoints

Make each checkpoint a separate, reviewable change. Run the dispatcher tests
and typecheck after each one.

1. **Shared helpers, no behavior change.** `rollout-policy.ts`,
   `host-resolution.ts`, `worker-exports.ts`. All existing tests pass without
   assertion changes.
2. **Cache lifetimes and SWR.** `DocsCacheLifetime`, `cacheControlFor`,
   `HtmlCacheProps.lifetime`. Approved assertion updates from section 9.
3. **C1.** `resolveHost` always uses `DocsHostCache`. Add the `index.test.ts`
   cases.
4. **Delivery identity and HTML key.** `delivery-identity.ts`, the identity
   header for `cachedLive`, `deliveryRenderId`. The rollout stays `off` by
   default.
5. **Route-data cache.** `live-route-data.ts`, `DocsRouteDataCache`,
   `route-data-endpoint.ts`, diagnostics, and the config and script changes
   (after approval).
6. **C2.** Hook, component, styles, mount. Compatibility suites and browser
   check.
7. **Documentation** (section 11).

## 13. Assumptions and open points

- Workers Cache supports `stale-while-revalidate` and `stale-if-error` on
  entrypoint caches. The Cloudflare configuration page documents both.
- Workers Cache uses Free-plan purge rate limits on every plan. Publish volume
  is low now. The outbox retries a failed purge.
- The Cloudflare docs do not say whether concurrent misses on one key merge into
  one run. This spec does not depend on it.
- The deploy script sets a valid `DOXA_RENDERER_RELEASE_ID` in the generated
  dispatcher config. If it does not, the feature stays inactive, logs one
  warning, and has no other effect.
