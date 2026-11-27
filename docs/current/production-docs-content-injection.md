# Production Docs Content Injection

**Status:** Describes the implemented state
**Last reviewed:** 2026-10-29

This document explains how published docs artifacts reach the docs-template
renderer. It also explains the renderer code package and every identity value
that the rendering system uses.

For the dispatcher rollout modes, see
[Production Docs Rendering](./production-docs-rendering.md). For saved HTML
delivery and publication, see
[Production Docs Pre-rendering](./production-docs-prerendering.md).

## The Three Players

- **docs-template** (`apps/docs-template`) is the React app. It knows how to
  draw a docs page. It does not know where the content is.
- **docs-runtime** (`apps/docs-runtime`) is a private Worker. It knows how to
  read the artifacts from R2. It does not draw anything.
- **docs-dispatcher** (`apps/docs-dispatcher`) is the public Worker
  `doxa-docs-renderer`. It receives the visitor request and connects the two
  players above.

## Artifacts in R2

Publication writes one immutable artifact set to the docs bucket. The folder
is `sites/{siteId}/versions/{versionId}/`. The folder holds one `tree.json`.
The tree maps each artifact path to a content-addressed blob under
`sites/{siteId}/blobs/`. Readers use the logical key `{artifactPrefix}/{path}`
and never build a blob key. See [Docs Content Storage](./docs-content-storage.md).

The set contains these logical files:

- `manifest.json` lists every page with its title and href. It carries
  `schemaVersion`, the artifact schema version the writer used. A manifest
  without the field is version 1. See
  [Docs Artifact Compatibility](./docs-artifact-compatibility.md).
- `settings/sections.json`, `settings/documents.json`, and
  `settings/features.json` hold navigation and feature flags.
- `source/**/index.mdx` holds one MDX body per page.
- `search/index.json` and `search/minisearch.json` hold the search data.

The database holds only a pointer. A hostname maps to a site, the site maps to
a published version, and the version maps to `artifactPrefix` and
`manifestPath`.

## Live Path

The live path runs when a visitor opens a page and no saved HTML exists.

### Step 1: The dispatcher finds the version

- A visitor opens `https://acme.doxa.page/getting-started`.
- The dispatcher asks the resolver service which site and which published
  version the hostname serves.
- The answer is the resolution object. It holds the site ID, the version ID,
  the artifact prefix, and the manifest path.
- The dispatcher caches this answer for five seconds.

### Step 2: The dispatcher starts a renderer

- For a public production site, the dispatcher starts a Dynamic Worker. Its ID
  is `docs:{siteId}:{publishedVersionId}:{rendererBuildId}`.
- The Dynamic Worker code is the built docs-template. The dispatcher reads that
  code from the `doxa-docs-renderer-code` bucket, through Workers Cache. See
  [How the object is read](#how-the-object-is-read).
- The dispatcher gives the Dynamic Worker three environment values. This step
  is the injection.
  1. `DOXA_DOCS_RUNTIME_SOURCE="binding"` tells docs-template to get content
     from a binding.
  2. `DOXA_DOCS_CONTENT_BINDING` is a small RPC object named
     `ScopedDocsContent`.
  3. `DOXA_DOCS_CONTENT_RESOLUTION` is the resolution from Step 1.
- The Dynamic Worker gets nothing else. It has no R2 access, no database
  access, and no network access. `globalOutbound` is `null`.
- Sites in the shared-isolate rollout use a different scope. See
  [Renderer Isolate Scope](#renderer-isolate-scope).

### Step 3: docs-template asks for content

- docs-template starts with `createDispatcherRuntimeSource` in
  `apps/docs-template/src/runtime/runtime-source-selection.ts`. That function
  reads the three values above and builds a runtime source object.
- The runtime source object has methods such as `getRouteData`, `getPage`, and
  `getNavigation`.
- A page loader calls one of these methods. The method sends an RPC call to
  `ScopedDocsContent`.
- `ScopedDocsContent` lives in `apps/docs-dispatcher/src/index.ts`. It adds
  the pinned resolution and a new trace to every call and forwards the call to
  docs-runtime. See [Route-Data Trace](#route-data-trace).
- docs-template can never change the resolution. The dispatcher sets it once
  when it creates the Dynamic Worker.
- On a cold start, the dispatcher may already have asked docs-runtime for the
  page's route data. See [Route-Data Prefetch](#route-data-prefetch).

### Step 4: docs-runtime reads the artifacts

- docs-runtime receives the resolution and the operation name in
  `runResolvedRuntimeRequest` (`apps/docs-runtime/src/runtime-source.ts`).
- It reads `manifest.json` from the artifact prefix through the version tree.
  It makes sure that the manifest site ID and prefix match the resolution.
- Then it reads the files that the operation needs. Examples are
  `settings/sections.json` and `source/getting-started/index.mdx`.
- It returns a JSON object. For a page, this object holds the MDX body, the
  title, the headings, and the navigation.
- docs-runtime keeps a 60-second memory cache for manifests and artifacts. It
  also keeps parsed version trees, which never change.

### Step 5: docs-template draws the page

- docs-template receives the JSON object.
- It parses the MDX body at request time with `@doxahq/mdx-runtime`.
- TanStack Start renders the HTML on the server and returns it to the
  dispatcher.
- The dispatcher stores this HTML in the Workers Cache for 30 days. The cache
  key includes the version ID and the renderer build.

### Other renderers

- Previews, permanent generation URLs, and mode `off` use the shared renderer
  `doxa-docs-renderer-shared`. It has the same `binding` runtime source. Its
  binding is a direct service binding to `RuntimeSourceApi` on docs-runtime,
  and it sends the request hostname instead of a pinned resolution.
- The pre-render Worker uses the same Dynamic Worker, the same binding, and the
  same pinned resolution. It calls the private `DocsPrerenderRenderer`
  entrypoint instead of `fetch`. The only difference is the time of the render.

## Renderer Isolate Scope

`apps/docs-dispatcher/src/renderer-isolate.ts` decides which isolate renders a
site. Both scopes run the same renderer code.

| Scope   | Isolate ID                                            | Site content                                                                                   |
| ------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `site`  | `docs:{siteId}:{publishedVersionId}:{rendererBuildId}` | In the isolate `env`, fixed when the isolate starts                                            |
| `build` | `docs:build:{rendererBuildId}`                        | In the entrypoint props of each call: `getEntrypoint(name, { props: { content, resolution } })` |

- In the `build` scope, the isolate `env` holds only values that are the same
  for every site. The loader runs only on a cold start, so a site value in
  `env` would reach every later request.
- `content` is the `ScopedDocsContent` binding pinned to `resolution`, the same
  object as in the `site` scope. It works only during the request that
  received it. A renderer that keeps it and uses it later gets "Cannot perform
  I/O on behalf of a different request".
- docs-template reads the props with `readRendererRequestScope` in
  `apps/docs-template/src/runtime/runtime-source-selection.ts`. A request
  scope wins over `env`. A `build` isolate without props has no content binding
  and fails closed.
- Module state in docs-template is shared by every site of a `build` isolate.
  Keep per-request data in the request context. Key a module cache by a content
  hash, or by the source's `cacheScope` (`site:{siteId}:{publishedVersionId}`)
  plus a content key, never by path, hostname or a content version alone. Bound
  every module cache.

### Limits of the shared isolate (M46 hardening)

One site must not use up the memory or the CPU of the isolate that every site
shares. These limits apply in both scopes:

| Limit | Value | Where | Above the limit |
| --- | --- | --- | --- |
| CPU per renderer call | 5 s (`RENDERER_LIMITS.cpuMs`) | `apps/docs-dispatcher/src/renderer-isolate.ts` | The call fails; a safe request falls back to the shared renderer |
| Search engine cache | 20 MB of serialized index, least recently used out first; key `{cacheScope}:{contentVersion}` | `apps/docs-template/src/lib/search/server-search.ts` | One site keeps at most 5 MB. A serialized index above 8 MB is not parsed: the search answers no results and logs `docs_search_index_too_large`; for an immutable `site:{id}:{version}` scope the marker is kept, so later searches skip the read |
| Page MDX at render | 512 KB (UTF-8) | `MAX_RENDERED_PAGE_BYTES` in `apps/docs-template/src/runtime/docs-route-data.ts` | A short "page too large" notice, and the log `docs_page_too_large` (`href`, `bytes`, `limitBytes`, `scope`) |
| Shiki line length | 2,000 characters (`tokenizeMaxLineLength`) | `packages/mdx-runtime/src/parser.ts` | The line is drawn without colors |
| Code block size | 32 KB (characters) | `MAX_HIGHLIGHTED_CODE_BLOCK_CHARS`, same file | The block is drawn as plain text |
| Code highlighted per page | 128 KB (characters) | `MAX_HIGHLIGHTED_CHARS_PER_PAGE`, same file | Later blocks are drawn as plain text |
| `/llms-full.txt` | 5 MB | `LLMS_FULL_MAX_BYTES` in `apps/docs-template/src/lib/llms.ts` | Page reads stop at the budget; the file keeps every page it read and ends with a note that `/llms.txt` lists every page. A corpus that fits the budget exactly is not marked truncated |
| `/llms.txt` | 2 MB of page bodies read for descriptions | `LLMS_INDEX_LOAD_OPTIONS`, same file | Later pages are listed with their navigation title and no description |
| Card icon components | 512 names, least recently used out first | `apps/docs-template/src/components/docs-icon.tsx` | An evicted name gets a new component with the same output |

The worst renderer call in the 29 Oct production tail took 2.4 s of wall time
after its code load (a `COLD` render), and the slowest `prepare` RPC used
148 ms of CPU in the dispatcher. Wall time bounds CPU time, so 5 s leaves
headroom. Shiki's JavaScript engine needs about 0.25 s of CPU for a 32 KB
block, so the page budget keeps highlighting near 1 s.

A call in the `build` scope without valid props fails closed with the code
`renderer_props_missing` (F35):

- `fetch` answers `500` with no content, `cache-control: private, no-store`
  and `x-doxa-renderer-error: renderer_props_missing`.
- `DocsPrerenderRenderer` throws an error whose message starts with
  `[renderer_props_missing]`.
- The renderer logs `{"event":"renderer_props_missing","entrypoint":…}`. The
  dispatcher logs `renderer_props_missing` with `siteId`,
  `publishedVersionId`, `entrypoint` and `fallback` before it falls back to
  the shared renderer (`apps/docs-dispatcher/src/dispatcher.ts`), or from
  `logRendererUse` for `prepare` and `render`.

Tests that prove the isolation:

- `apps/docs-template/src/shared-isolate.test.ts`: two sites with unique
  markers in name, navigation, body, theme colour, icons and search documents
  (the same `contentVersion`), 64 mixed concurrent calls with random delays
  through `server.fetch` and `DocsPrerenderRenderer` with per-call props (HTML,
  `/_serverFn` route data, `/llms.txt`, `/llms-full.txt`, `.md`,
  `/api/search`, `prepare`, `render`). No response carries the other site's
  markers. The same file checks missing and invalid props.
- `apps/docs-template/src/lib/search/server-search.test.ts`: separate engines
  for one `contentVersion` under two sites, and the byte budget.
- `apps/docs-dispatcher/tests/shared-isolate-props.test.ts`: two sites
  interleaved on one isolate ID each get their own props for `fetch`,
  `DocsPrerenderRenderer` and the `DocsHtmlCache` path.

The rollout uses two dispatcher variables:

- `DOXA_PROD_SHARED_ISOLATE_MODE`: `off`, `allowlist` or `all`. An invalid
  value logs a warning and keeps every site in the `site` scope.
  `pnpm validate:production-config` rejects an invalid value.
- `DOXA_PROD_SHARED_ISOLATE_SITE_IDS`: comma-separated site IDs for
  `allowlist`. The config holds the placeholder
  `${OPS_DOCS_SHARED_ISOLATE_SITE_IDS}`, and the ops repo holds the value.

To revert, set `DOXA_PROD_SHARED_ISOLATE_MODE` to `off` in
`apps/docs-dispatcher/wrangler.json`, or remove the site from the ops value,
then deploy the `docs-rendering` step. The renderer code supports both scopes,
so a revert needs no renderer change.

Every renderer call logs `docs_renderer_load` with `entrypoint` (`fetch`,
`prepare` or `render`), `isolateScope`, `rendererBuildId`, `state` (`COLD`
or `WARM`), `codeLoadMs`, `codeSource`, `totalMs`, and `ok` with `status` or
`error`. A `COLD` call has `codeSource`:

| `codeSource` | Where the code came from |
| --- | --- |
| `memory` | This dispatcher isolate had already loaded the package |
| `cache` | A stored copy in Workers Cache (`DocsRendererCodeCache`) |
| `r2` | The R2 bucket: a cache fill, or the direct read after a cache failure |

Compare the `COLD` share and `totalMs` by `isolateScope` to judge the rollout.

A page render (`fetch`) also logs the renderer's own timing. docs-template
sends it in the internal header `x-doxa-renderer-timing`
(`apps/docs-template/src/runtime/renderer-timing.ts`), only for a
dispatcher-pinned render, and `apps/docs-dispatcher/src/renderer-timing.ts`
removes the header before the response reaches Workers Cache or a visitor.
The line is written when the body has streamed to the end.

| Field | Meaning |
| --- | --- |
| `renderer.isolateId`, `renderer.isolateRequests`, `renderer.isolateAgeMs` | Which isolate rendered, how many requests it has served, and how long since its first request |
| `phases.beforeHandlerMs` | Dispatcher call until the renderer handler starts: code load, isolate start, module evaluation and the hop. Subtract `codeLoadMs` for the isolate start of a COLD call. |
| `phases.handlerMs` | Renderer handler start until it returns: content RPCs and the CPU work between them |
| `phases.routeDataMs`, `phases.siteConfigMs` | The route-data and site-config steps inside the handler |
| `phases.contentCalls`, `phases.contentMs`, `phases.longestContentMs` | Content RPCs through the dispatcher to docs-runtime |
| `phases.afterHandlerMs` | Renderer handler end until the response reaches the dispatcher |
| `bodyMs`, `bytes` | Streaming of the body after the response arrived |

Inside a Worker, the clock advances only on I/O. CPU work after the
renderer's last I/O, such as rendering the page shell, therefore falls into
`afterHandlerMs`, not `handlerMs`. The two clocks belong to different
isolates, so small negative values can appear.

## Route-Data Prefetch

A cold renderer asks for its route data only after its own start (about
440 ms), and in a cold data center that `getRouteData` call took 250–330 ms
more (production, 28 Oct). The two waits were in sequence.
`apps/docs-dispatcher/src/route-data-prefetch.ts` lets them overlap:

1. For a page request (a `GET` that `isPrerenderableDocsRequest` accepts) of
   a site in the rollout, the dispatcher makes a prefetch ID and puts it in
   the `ScopedDocsContent` props as `routeDataPrefetchId`.
2. When `LOADER.get` runs the code callback, this request starts the isolate.
   Only then does the dispatcher send `getRouteData` to docs-runtime, pinned
   to the same trusted resolution, with the pathname that docs-template will
   send (`toRuntimeHref`, a copy of `normalizeRuntimeHref`; a test keeps the
   two equal). `ctx.waitUntil` keeps the call alive. A warm render sends
   nothing extra.
3. When the renderer's `getRouteData` reaches `ScopedDocsContent` in the same
   dispatcher isolate, with the same resolution and the same payload, it gets
   the prefetched answer. This happens once per prefetch. An error answer or
   a thrown RPC makes it call docs-runtime itself, as before.
4. When the renderer's call reaches another dispatcher isolate, it calls
   docs-runtime itself. The prefetch then only warmed docs-runtime: its
   isolate, its 60-second memory cache and its `caches.default` blob cache in
   that data center.

The private `prepare` entrypoint (route-data cache fills, saved route data and
the pre-render Worker) prefetches too. It has no request, but it always asks
for the route data of its own pathname. So `withPrivatePrerenderRenderer`
builds the plan from that pathname (`planPathnameRouteDataPrefetch`) and starts
it on a cold start, in the same way. `render` and `getPlan` do not prefetch.

The renderer and its public contract do not change: it makes the same RPC,
and the HTML comes from the same `fetch` path. The prefetch ID is set only by
the dispatcher, and a prefetched answer is only ever the answer to the same
call for the same resolution. Each entry lives until its render reports, or
one minute at most.

`docs_renderer_load` of a render that started a prefetch has
`routeDataPrefetch`:

| Field | Meaning |
| --- | --- |
| `outcome` | `handedOff` (the renderer got the prefetched answer), `fellBack` (the prefetch failed, the renderer called docs-runtime itself) or `notTaken` (the renderer's call reached another dispatcher isolate or asked for other data) |
| `prefetchMs` | Duration of the prefetch RPC |
| `leadMs` | Prefetch start until the renderer asked for route data |
| `waitMs` | How long the renderer still waited for the prefetched answer. `0` means full overlap |
| `traceId` | The trace ID of the prefetch call. Find the same ID in `docs_runtime_reads` |
| `calleeMs` | Time inside docs-runtime (its `timing.totalMs`) |
| `outsideMs` | `prefetchMs` minus `calleeMs`: the RPC transport and queueing |
| `runtimeIsolate` | The docs-runtime isolate: `id`, `requests` (calls it ran) and `ageMs` |
| `reads`, `r2Reads`, `readMs` | Storage reads of the call, the reads that went to R2, and their total time |
| `manifestMs` | Time to read the manifest |
| `responseBytes` | JSON size of the route data |

The fields from `calleeMs` on come from docs-runtime. They are absent when
docs-runtime sent no timing (an older deploy) or the call failed.
`entrypoint` tells a `fetch` render from a `prepare` call.

Compare `phases.routeDataMs` of `COLD` renders with and without the field.
For `notTaken`, `phases.routeDataMs` shows what the warm-up alone gave.

The rollout uses two dispatcher variables:

- `DOXA_PROD_ROUTE_DATA_PREFETCH_MODE`: `off`, `allowlist` or `all`. Unset or
  invalid means `off` (an invalid value logs a warning).
  `pnpm validate:production-config` rejects an invalid value. Production is
  `all`.
- `DOXA_PROD_ROUTE_DATA_PREFETCH_SITE_IDS`: comma-separated site IDs for
  `allowlist`.

To revert, set `DOXA_PROD_ROUTE_DATA_PREFETCH_MODE` to `off` in
`apps/docs-dispatcher/wrangler.json`, then deploy the `docs-rendering` step.
The renderer needs no change. The same mode controls the `fetch` and the
`prepare` prefetch.

## Route-Data Trace

The dispatcher traces every `request` call that it sends to docs-runtime, so
one call can be followed from `docs_renderer_load` to `docs_runtime_reads`.

- The dispatcher makes the trace: `{ id, caller }`. `id` is
  `crypto.randomUUID()`. `caller` is `prefetch` (the route-data prefetch),
  `content` (a renderer call through `ScopedDocsContent`) or `plan`
  (`PrerenderRendererApi.getPlan`). The dispatcher never takes a trace from
  renderer input.
- docs-runtime parses the trace (`readDocsRuntimeTrace` in
  `packages/contracts/src/docs-runtime-trace.ts`). An invalid trace counts as
  none.
- For a traced call, docs-runtime adds `timing` to its answer:
  `manifestMs`, `operationMs`, `firstReadMs`, `totalMs`, `reads`, `r2Reads`,
  `readMs`, `responseBytes` (route data only), `versionColdInIsolate` and
  `isolate { id, requests, ageMs }`. The isolate ID is random. The first call
  in an isolate makes it.
- The dispatcher parses `timing` and removes it before the answer goes to the
  renderer. So the renderer contract does not change.
- `docs_runtime_reads` gets `traceId`, `caller`, `isolate`, `manifestMs`,
  `operationMs` and `versionColdInIsolate`. `versionColdInIsolate` is true for
  the first call for a version in that docs-runtime isolate.
- docs-runtime also writes `docs_runtime_reads` with `ok: false` and
  `errorCode` for `invalid_request` and `version_not_found`, for every
  operation. The line has IDs only, never the payload.

Both fields are optional. An old dispatcher sends no trace and gets the old
answer. An old docs-runtime ignores the trace and sends no timing. Deploy
docs-runtime before docs-rendering, so the timing fields are there from the
first dispatcher request.

## Renderer Code Package

### What the bucket is

- `doxa-docs-renderer-code` is a private R2 bucket. It holds the server code
  of docs-template, not the docs content.
- Each object is one complete build of the renderer. The dispatcher loads this
  code into every Dynamic Worker.
- One object key has this form: `renderer-code/{buildId}.json.gz`.

### What is inside one object

The object is one gzip file. Inside is one JSON document with these fields:

| Field                | Content                                                                  |
| -------------------- | ------------------------------------------------------------------------ |
| `schemaVersion`      | Always `1`.                                                              |
| `buildId`            | SHA-256 hash of the package content. It is also the file name.           |
| `compatibilityDate`  | Copied from the built Wrangler config.                                   |
| `compatibilityFlags` | Copied from the same config, for example `nodejs_compat`.                |
| `mainModule`         | The entry file name, `index.js`.                                         |
| `modules`            | A map from file name to file source. Every `.js` and `.mjs` file under `dist/server` is one entry. |

The `modules` map is the real payload. It is the full SSR bundle of
docs-template as plain JavaScript text.

| Limit                     | Value   |
| ------------------------- | ------- |
| Uncompressed size         | 25 MiB  |
| Compressed size           | 10 MiB  |
| Module count              | 500     |

The client assets (CSS, browser JavaScript, fonts) are not in the renderer
package. The dispatcher serves the current build's files from its own `ASSETS`
binding. The deploy also copies them into this bucket under
`client-assets/v1/assets/`, for pages loaded before a later deploy (see
[Old client assets](#old-client-assets)).

The deploy builds the renderer with `DOXA_RENDERER_BUILD=platform`. That
build minifies the server code and leaves out the local content source
(`import.meta.env.DOXA_OMIT_LOCAL_CONTENT_SOURCE`). Its server Mermaid module
is a stub, because Mermaid draws only in the browser. A Dynamic Worker compiles
every module of the package on each cold start, used or not. These steps took
the package from 94 modules and 16.6 MB to 29 modules and 5.5 MB. The changes
of 2026-10-29 below took it to 50 modules, 3.5 MB and 0.73 MB compressed
(from 1.19 MB). There are more modules because each code grammar is now its
own small chunk.

### Server code highlighting

The renderer highlights code fences with one Shiki instance per isolate.
`apps/docs-template/src/config/vite/workspace-aliases.ts` points every
`@doxahq/mdx-runtime` import at the package source, so `@doxahq/docs-prose`
and the template share one highlighter module.

Page renders and `prepare` use `apps/docs-template/src/runtime/server-highlighter.ts`.
It starts with the themes only and loads the grammars of the fences that
`collectFenceLanguages` finds in the page (the lazy loader of
`@doxahq/mdx-runtime/highlight-lazy`). If the parser highlights a fence whose
grammar the scan missed, the page is parsed again after that grammar loads.
The output is the same as with the highlighter that holds every grammar. A
test in `server-highlighter.test.ts` compares both for every page of every
frozen artifact set. Loaded grammars stay loaded for the life of the isolate.

An HTML page render imports and creates this highlighter before it waits for
`getRouteData` (`startServerHighlighter` in `apps/docs-template/src/server.ts`),
and starts loading the page's grammars when the route data arrives.

### Startup module graph

V8's code cache of the isolate start covers only the modules that the entry
imports at startup. A chunk behind a dynamic import is compiled on its first
use, inside the first render. The platform build therefore adds
`eagerServerChunksPlugin` (`apps/docs-template/src/config/vite/eager-server-chunks.ts`):
the server entry `index.js` imports the chunks that every page render loads
(router, page routes, route-data and site-config server functions, the server
highlighter and its themes). `PAGE_RENDER_MODULES` lists them. The build fails
if one of them is in no chunk. Chunks for some pages only (chat, search, the
full Lucide set, API reference bodies, diagrams, code grammars) stay lazy. The
client build and the `vite` content source build do not use the plugin.

### Chat in the platform renderer

Chat with Docs answers from the template's own content (`contentStore`) with
the server's `AI_API_KEY`. The platform renderer has neither, so it serves no
chat: its build leaves out `apps/docs-template/src/lib/chat-stream.ts` (the AI
provider SDKs and the assistant tools) and the server copy of the chat UI. The
`chatWithDocsStream` server function stays registered and answers `403` when
the site has chat turned off, or `503` otherwise. This removed about 1.2 MB
from the server package. The chat controls (the navbar button, "Chat with
page" and the chat panel) draw only when `isChatAvailable(features)` is true
(`apps/docs-template/src/lib/chat-availability.ts`): the site turns chat on
and the build is not the platform renderer. The template's own build keeps
chat.

`/llms.txt`, `/llms-full.txt` and the `.md` routes read the requesting site's
pages through its runtime source (`apps/docs-template/src/lib/llms.ts`,
`apps/docs-template/src/lib/raw-markdown.ts`). Until 2026-10-29 the llms
routes read `contentStore`, so every production site served the template's
own demo pages under its name. With no reader of `contentStore` left, the
platform build also drops the template's demo pages and `gray-matter` from the
server bundle, about 1.1 MB more.

### How the object is built

The script `apps/docs-template/scripts/deploy-renderer.mjs` runs these steps
in order:

1. Run `vite build` for docs-template with the shared renderer config. This
   step writes `dist/server` and `dist/client`.
2. Run `apps/docs-dispatcher/scripts/package-renderer.mjs`.
3. That script reads every JavaScript file under `dist/server`.
4. It parses each file with `es-module-lexer`. If a relative import points to
   a missing file, the script stops.
5. It builds the JSON document above without the build ID. Then it hashes the
   JSON to get the build ID.
6. It hashes every file under `dist/client/assets` to get the client asset
   digest. These are the content-hashed files that HTML links to. Fixed-name
   files are left out: they keep their URLs, and the template rebuilds
   `pages.json` and `sitemap.xml` with new timestamps on every build.
7. It hashes the build ID, the client digest, and the output schema version
   together. The result is the renderer release ID.
8. It gzips the JSON at level 9 with a fixed mtime of zero. The same input
   always gives the same bytes.
9. It writes three files to `apps/docs-dispatcher/dist`: the `.json.gz`
   package, `renderer-package.json` with the metadata, and
   `wrangler.production.json` for the dispatcher.
10. The generated dispatcher config carries `DOXA_RENDERER_BUILD_ID`,
    `DOXA_RENDERER_PACKAGE_KEY`, and `DOXA_RENDERER_RELEASE_ID`. The API and
    the pre-render Worker get the same release ID in their generated configs.
11. It also carries the previous build (`DOXA_PREVIOUS_RENDERER_BUILD_ID`,
    `DOXA_PREVIOUS_RENDERER_RELEASE_ID`) and `DOXA_RENDERER_DEPLOYED_AT`,
    planned from the release record and the required `--previous-fallback`
    choice. See
    [Docs Artifact Compatibility](./docs-artifact-compatibility.md#previous-build-fallback).

### When the object is stored

- The upload happens only during `pnpm deploy:docs-template`. The production
  GitHub workflow runs this command with `--skip-secret`.
- The deploy order is fixed. First the deploy reads the release record
  `renderer-code/releases/current.json` from the renderer code bucket. Second
  the client assets upload to R2 (see [Old client assets](#old-client-assets)).
  Third the shared renderer deploys. Fourth the package uploads to R2. Fifth
  the dispatcher deploys with the new build ID and the previous build. Then
  the deploy writes the new release record. Last the pre-render Worker and the
  API deploy.
- The upload command is `wrangler r2 object put` with
  `--content-encoding gzip` and `--force`. A rerun with the same code
  overwrites the same key with the same bytes.
- A dry run builds and validates the package. It does not upload or deploy
  anything.
- The bucket must exist before the first deployment. The script does not
  create it.
- Old objects stay in the bucket. Nothing in the repository deletes them. A
  rollback to an older dispatcher config points at an older key that still
  exists. This restores the Dynamic Worker package selection only. A complete
  rollback also coordinates the shared renderer, runtime, and release settings.
  See [Rollout And Rollback](./docs-artifact-compatibility.md#rollout-and-rollback).

### Old client assets

A page that a visitor loaded before a renderer deploy still asks for the
hashed client files of its build, for example on a client navigation. The new
dispatcher's `ASSETS` binding has only the new files.

- Upload: after packaging and before the shared renderer deploy,
  `deploy-renderer.mjs` puts every file of `apps/docs-template/dist/client/assets/`
  to `client-assets/v1/assets/{file}` in the renderer code bucket, with the
  content type from the extension and
  `cache-control: public, max-age=31536000, immutable`. It runs
  `wrangler r2 object put --remote`, 6 at a time, and re-puts every file on
  every deploy. A dry run skips it. The plan is a pure function in
  `scripts/deploy/lib/client-assets-upload.mjs`. The upload does not change the
  release ID.
- Expiry: a lifecycle rule on the prefix `client-assets/` (exactly that prefix)
  deletes the files 30 days after their last upload. A rule on a wider prefix
  would delete renderer packages and break every site.
- Serving: with `DOXA_PROD_CLIENT_ASSET_FALLBACK_MODE=on`,
  `apps/docs-dispatcher/src/client-asset-fallback.ts` answers a `GET` or `HEAD`
  for a hashed `.js` or `.css` name under `/assets/` that `ASSETS` did not
  serve, through `DocsClientAssetCache`
  (`client-asset-cache-entrypoint.ts`). Headers come from an allowlist; R2
  metadata is never copied. See
  [Production Docs Caching](production-docs-caching.md#old-client-assets).

### How the object is read

- The dispatcher reads the object on the first request for a new Dynamic
  Worker ID. This read is the cold `doxa_code` timing, and `codeLoadMs` in
  `docs_renderer_load`.
- The read goes through the dispatcher's own cache entrypoint
  `DocsRendererCodeCache` (`apps/docs-dispatcher/src/renderer-code-cache-entrypoint.ts`).
  Its props are `DOXA_RENDERER_BUILD_ID`, `DOXA_RENDERER_PACKAGE_KEY` and a
  format number, and its URL is `https://renderer-code.internal/v1/{buildId}`.
  It refuses any other build, key, format or URL, so no request value can
  select a package. A cache fill reads the gzip bytes from R2 and stores them
  unchanged for 30 days: a package key names one immutable build. With
  `cross_version_cache`, the next dispatcher deploy with the same build reads
  the same entry.
- Fills often run in a new dispatcher isolate, in the upper cache tier. Before
  this cache, each one paid an R2 GET: 53–314 ms in Europe and 218–817 ms in
  Singapore (production, 28 Oct). Gunzip and `JSON.parse` of the 5.5 MB
  package cost about 25 ms of CPU (15 ms gunzip, 10 ms parse, measured on
  Node); in a Worker the clock does not move during CPU work, so that cost is
  not part of `codeLoadMs`.
- When the cache entrypoint fails, or its bytes fail the checks below, the
  dispatcher logs a warning and reads the bucket directly
  (`createRendererCodeReaders` in `apps/docs-dispatcher/src/renderer-code-readers.ts`).
  A bad cache entry therefore costs one more read, never a broken render.
- It decompresses the stream with `DecompressionStream("gzip")` and parses the
  JSON in `apps/docs-dispatcher/src/renderer-code-package.ts`.
- It rejects the package if the build ID differs from
  `DOXA_RENDERER_BUILD_ID`, if the schema version is not 1, if a module name
  contains `..`, or if the module count is more than 500.
- The dispatcher keeps the last five parsed packages in memory per isolate. A
  warm Dynamic Worker never reads the bucket again.
- The package is not in the `ASSETS` binding on purpose. Without
  `run_worker_first`, every file there is public on every docs hostname, and
  this package is the renderer's server code. Bundling it into the dispatcher
  script would make every dispatcher cold start pay for 5.5 MB, also on HTML
  cache hits.
- The parsed fields go directly into the `LOADER.get` call as `mainModule`,
  `modules`, `compatibilityDate`, and `compatibilityFlags`.

### Why this design

- The shared renderer is a normal deployed Worker. A Dynamic Worker cannot be
  deployed with Wrangler, so its code must come from storage at runtime.
- The build ID is part of the Dynamic Worker ID. A new build gives every site
  a new isolate with the new code. An old isolate never runs mixed code.
- The release ID is part of the pre-render identity. A new build makes all
  saved HTML stale, and the scheduler renders it again.

## Identity Values

The values fall into three groups: content identity, code identity, and
combined identity.

### Group 1: Content identity (what docs to show)

These values come from the database. The resolver returns them for one
hostname. The schemas are `docsHostResolutionSchema` and
`docsDomainResolutionSchema` in `packages/contracts/src/index.ts`.

| Value                | Meaning                                                                                                   | Example                              |
| -------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `hostname`           | The public domain of the request.                                                                         | `acme.doxa.page`                     |
| `siteId`             | One docs site. A site owns hostnames, versions, and artifacts. It is a stable segment in every R2 key.    | `site_8f2a`                          |
| `projectId`          | The database ID of the project that the site belongs to. The agent generates docs for a project.         | uuid                                 |
| `projectSlug`        | The short name of the project. It is used for links and labels.                                           | `acme-sdk`                           |
| `publishedVersionId` | The database ID of the version that the production pointer selects now. A publish or a promotion changes it. | uuid                              |
| `artifactPrefix`     | The R2 folder that holds the artifact set of one version. The runtime reads all content under this prefix. | `sites/{siteId}/versions/{versionId}` |
| `manifestPath`       | The full key of `manifest.json` under the prefix. The manifest lists every page.                         | `{artifactPrefix}/manifest.json`     |
| `accessPolicy`       | `public` or `authenticated`. Only `public` production sites get saved HTML and shared HTML cache.         | `public`                             |
| `domainKind`         | `doxa_subdomain` or `custom_domain`.                                                                      | `doxa_subdomain`                     |
| `renderTarget`       | `production`, `preview`, or `generation_snapshot`. Only `production` goes to a Dynamic Worker.            | `production`                         |

- `DocsHostResolution` holds the first seven values. The Dynamic Worker gets
  only this object.
- `DocsDomainResolution` adds the last three values. Only the dispatcher sees
  them.
- A promoted version can point to an older artifact folder. Then the database
  version ID and the version ID inside the manifest differ. The runtime pins
  the manifest by `siteId`, `artifactPrefix`, and `manifestPath`, not by the
  database ID.

### Group 2: Code identity (what renderer to run)

These values come from the build. The deploy script writes them into the
dispatcher config.

| Value                                            | Meaning                                                                  | How it is made                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `buildId` (`DOXA_RENDERER_BUILD_ID`)             | One exact server bundle of docs-template.                                | SHA-256 of the JSON package without the ID: compatibility date, flags, main module, and all module sources. |
| `DOXA_RENDERER_PACKAGE_KEY`                      | The R2 key of that bundle.                                               | `renderer-code/{buildId}.json.gz`                                                                     |
| `clientAssetManifestDigest`                      | One exact set of browser assets.                                         | SHA-256 of the sorted list of path, hash, and size of every file under `dist/client`.                 |
| `outputSchemaVersion`                            | The shape of saved HTML and route data. Always `1` now.                  | Constant in the package script.                                                                       |
| `rendererReleaseId` (`DOXA_RENDERER_RELEASE_ID`) | One complete renderer release: server code, client assets, output shape. | SHA-256 of `buildId`, `clientAssetManifestDigest`, and `outputSchemaVersion`.                         |

- The build ID changes when server code changes. The release ID changes when
  server code, client assets, or the output shape changes.
- The Dynamic Worker uses the build ID. The saved HTML uses the release ID.
- `DocsHtmlCache` keys on the build ID and on the delivery `renderId`, which
  contains the release ID. Cached HTML embeds the `renderId` and links to
  client asset file names, so a client-only release must select a new entry.
  Saved HTML links to client asset file names, so a client change must also
  invalidate saved HTML.

### Group 3: Combined identity (content plus code)

These values join a content identity with a code identity. The functions are
in `packages/contracts/src/docs-prerender.ts` and
`apps/docs-dispatcher/src/routing-policy.ts`.

| Value                    | Meaning                                                                                   | How it is made                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Dynamic Worker ID        | One isolate that runs one build for one version of one site.                              | `docs:{siteId}:{publishedVersionId}:{buildId}`                                                    |
| `artifactIdentity`       | One exact artifact set, independent of the database version ID.                           | SHA-256 of `siteId`, `artifactPrefix`, `sourceManifestPath`, and schema version.                   |
| `renderContextId`        | The public conditions of a render.                                                        | SHA-256 of `trustedRequestOrigin`, the public output configuration, and schema version.            |
| `trustedRequestOrigin`   | The HTTPS origin that the saved HTML was rendered for. Absolute links depend on it.       | `https://acme.doxa.page`                                                                          |
| `sourceArtifactVersion`  | The last segment of `artifactPrefix`. It is the version ID inside the artifact folder name. | `{versionId}`                                                                                   |
| `renderId`               | One saved render: one artifact set, rendered by one release, for one origin.              | SHA-256 of `siteId`, `artifactIdentity`, `rendererReleaseId`, `renderContextId`, and schema version. |
| Saved output prefix      | The R2 folder of one render in `doxa-docs-rendered-html`.                                 | `render/v1/sites/{siteId}/renders/{renderId}/`                                                    |
| Object digest            | One HTML or JSON body inside a render.                                                    | SHA-256 of the bytes. Key is `objects/{digest}.html` or `.json`.                                  |

### How a request uses them

- The dispatcher resolves the hostname and gets Group 1.
- It reads Group 2 from its own environment.
- For saved HTML, it recomputes `renderId` from Group 1 and Group 2. Then it
  reads the manifest under that render prefix. A client cannot supply a render
  ID, only a hint.
- For live HTML, it builds the Dynamic Worker ID from `siteId`,
  `publishedVersionId`, and `buildId`. The isolate loads the package at
  `DOXA_RENDERER_PACKAGE_KEY` and rejects it if its inner `buildId` differs.

### What changes what

| Event                         | New `publishedVersionId` | New Worker ID | New `buildId` | New `releaseId` | New `renderId`                             |
| ----------------------------- | ------------------------ | ------------- | ------------- | --------------- | ------------------------------------------ |
| Publish new docs              | yes                      | yes           | no            | no              | yes                                        |
| Promote an older version      | yes                      | yes           | no            | no              | only if the artifact prefix differs        |
| Deploy new server code        | no                       | yes           | yes           | yes             | yes                                        |
| Deploy new client assets only | no                       | no            | no            | yes             | yes                                        |
| Add a custom domain           | no                       | no            | no            | no              | yes, because the origin differs            |

## Main Files

- `apps/docs-dispatcher/src/index.ts`
- `apps/docs-dispatcher/src/route-data-prefetch.ts`
- `apps/docs-dispatcher/src/runtime-trace.ts`
- `apps/docs-dispatcher/src/renderer-code-package.ts`
- `apps/docs-dispatcher/src/routing-policy.ts`
- `apps/docs-dispatcher/scripts/package-renderer.mjs`
- `apps/docs-template/scripts/deploy-renderer.mjs`
- `scripts/deploy/lib/client-assets-upload.mjs`
- `apps/docs-dispatcher/src/client-asset-fallback.ts`
- `apps/docs-dispatcher/src/client-asset-cache-entrypoint.ts`
- `apps/docs-dispatcher/src/text-cache-entrypoint.ts`
- `apps/docs-template/src/server.ts`
- `apps/docs-template/src/runtime/runtime-source-selection.ts`
- `apps/docs-template/src/runtime/binding-runtime-source.ts`
- `apps/docs-runtime/src/runtime-source.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/docs-prerender.ts`
- `packages/contracts/src/docs-runtime-trace.ts`
- `apps/docs-runtime/src/runtime-trace.ts`
- `packages/docs-engine/src/index.ts`
