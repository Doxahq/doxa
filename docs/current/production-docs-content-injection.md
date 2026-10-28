# Production Docs Content Injection

**Status:** Describes the implemented state
**Last reviewed:** 2026-09-30

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
  code from the `doxa-docs-renderer-code` bucket.
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
  the pinned resolution to every call and forwards the call to docs-runtime.
- docs-template can never change the resolution. The dispatcher sets it once
  when it creates the Dynamic Worker.

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
- The dispatcher stores this HTML in the Workers Cache for 1 year. The cache
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
  hash, never by path, hostname or site alone.

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
or `WARM`), `codeLoadMs`, `totalMs`, and `ok` with `status` or `error`.
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

The client assets (CSS, browser JavaScript, fonts) are not in this bucket. The
dispatcher serves them from its own `ASSETS` binding.

The deploy builds the renderer with `DOXA_RENDERER_BUILD=platform`. That
build minifies the server code and leaves out the local content source
(`import.meta.env.DOXA_OMIT_LOCAL_CONTENT_SOURCE`). Its server Mermaid module
is a stub, because Mermaid draws only in the browser. A Dynamic Worker compiles
every module of the package on each cold start, used or not. These steps took
the package from 94 modules and 16.6 MB to 29 modules and 5.5 MB.

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
from the server package.

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

### When the object is stored

- The upload happens only during `pnpm deploy:docs-template`. The production
  GitHub workflow runs this command with `--skip-secret`.
- The deploy order is fixed. First the shared renderer deploys. Second the
  package uploads to R2. Third the dispatcher deploys with the new build ID.
  Fourth the pre-render Worker and the API deploy.
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

### How the object is read

- The dispatcher reads the object on the first request for a new Dynamic
  Worker ID. This read is the cold `doxa_code` timing.
- It decompresses the stream with `DecompressionStream("gzip")` and parses the
  JSON in `apps/docs-dispatcher/src/renderer-code-package.ts`.
- It rejects the package if the build ID differs from
  `DOXA_RENDERER_BUILD_ID`, if the schema version is not 1, if a module name
  contains `..`, or if the module count is more than 500.
- The dispatcher keeps the last five parsed packages in memory per isolate. A
  warm Dynamic Worker never reads the bucket again.
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
- `apps/docs-dispatcher/src/renderer-code-package.ts`
- `apps/docs-dispatcher/src/routing-policy.ts`
- `apps/docs-dispatcher/scripts/package-renderer.mjs`
- `apps/docs-template/scripts/deploy-renderer.mjs`
- `apps/docs-template/src/server.ts`
- `apps/docs-template/src/runtime/runtime-source-selection.ts`
- `apps/docs-template/src/runtime/binding-runtime-source.ts`
- `apps/docs-runtime/src/runtime-source.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/docs-prerender.ts`
- `packages/docs-engine/src/index.ts`
