# Production Docs Rendering

Saved production HTML and route data are documented in [Production Docs Pre-rendering](./production-docs-prerendering.md).
The content injection flow, the renderer code package, and every identity value are documented in [Production Docs Content Injection](./production-docs-content-injection.md).

**Status:** Enabled for all production sites
**Default mode:** `all`
**Last reviewed:** 2026-09-23

## Purpose

Doxa can run each published production version in a separate isolate. Preview traffic continues to use one shared renderer.

This split keeps preview cost predictable. It also gives a production version
its own Worker identity and code cache.

A Worker identity does not promise one permanent isolate. Cloudflare can create
or remove isolates as needed.

## Request Flow

`doxa-docs-renderer` is the public dispatcher.

It uses this order:

1. Read the deployment mode.
2. If the mode is `off`, send the request to the shared renderer.
3. Otherwise, resolve the request hostname through the API service binding.
4. Keep preview and permanent generation URLs on the shared renderer.
5. Send an enabled production site to a Dynamic Worker.
6. If a safe dynamic request fails, retry it on the shared renderer.

The safe retry applies to `GET` and `HEAD`. Doxa does not replay other methods.

The dispatcher now includes an early public-production cache policy: a
five-second hostname cache followed by version-keyed HTML caching. Previews and
shared-renderer responses remain outside the HTML cache. See
[Production Docs Caching](production-docs-caching.md) for the safety boundaries,
freshness trade-off, rollback, and pending production verification.

The Dynamic Worker ID has this form:

```text
docs:{siteId}:{publishedVersionId}:{rendererBuildId}
```

A new production version or renderer build gets a new ID.

A promoted database version can reuse an older immutable artifact. In that
case, the database version ID and manifest version ID differ. The runtime pins
the manifest to its site, artifact prefix, and manifest path. It does not
require the promoted database ID to equal the source artifact ID.

## Renderer Rollout Policy

The renderer is evergreen. The selected release applies to every production
site. No site pins an older build, and no published version stores a build ID.
The dispatcher, shared renderer, and docs runtime deploy separately, so an
upgrade or rollback can temporarily mix releases. A complete rollback must
coordinate the affected services and preserve artifact-format support.

Because of this, the renderer must read every artifact set Doxa ever
published. The contract, the artifact schema version, and the compatibility
gate are documented in
[Docs Artifact Compatibility](./docs-artifact-compatibility.md). Run the
compatibility suites before every renderer deploy.

A canary rollout, which sends a new build to an allowlist of sites before all
sites, is planned and not built. Until it exists, every deploy is a full
rollout. The rollout modes below select the shared or dynamic renderer. They
do not select a build.

## Rollout Modes

`DOXA_PROD_DYNAMIC_RENDERER_MODE` supports three values.

| Value       | Behavior                                                                            |
| ----------- | ----------------------------------------------------------------------------------- |
| `off`       | All requests use the shared renderer. The dispatcher does not resolve the hostname. |
| `allowlist` | Only listed production site IDs use Dynamic Workers.                                |
| `all`       | All production site IDs use Dynamic Workers.                                        |

`DOXA_PROD_DYNAMIC_RENDERER_SITE_IDS` is a comma-separated list for allowlist
mode.

The tracked Wrangler config and deployment command default to `all`. The
deployment command creates a temporary config with the selected mode. To move
back to an allowlist, use this command:

```bash
pnpm deploy:docs-template -- --previous-fallback on --mode allowlist --site-ids site-id-1,site-id-2
```

To send all requests to the shared renderer, use this command:

```bash
pnpm deploy:docs-template -- --previous-fallback on --mode off
```

Every renderer deploy needs `--previous-fallback on|off` (or the
`DOXA_RENDERER_PREVIOUS_FALLBACK` variable); there is no default. `on` lets
the dispatcher serve the replaced build's cached output while the new build
warms; `off` does not (use it for a security fix). `--revoke <releaseId>`
marks a release that must never be that fallback. Through the ops repo, pass
the flag to `deploy.sh`, for example
`scripts/deploy.sh main --step docs-rendering --previous-fallback off`. See
[Docs Artifact Compatibility](./docs-artifact-compatibility.md#previous-build-fallback).

## Request Timing Diagnostics

The dispatcher can add request measurements for short production tests. The
tracked `DEBUG` Worker variable defaults to `false`.

- Set `DEBUG=true` to add Doxa measurements to the `Server-Timing` response
  header and write one structured `docs_request_timing` log for each request.
- Set `DEBUG=false` or remove the variable to disable both outputs. The deploy
  command accepts only `true` or `false` and rejects other values.

For a local production deployment, set the variable on the renderer command:

```bash
DEBUG=true pnpm deploy:docs-template -- --skip-secret --previous-fallback on
```

Use `DEBUG=false` with the same command to turn the measurements off again. The
manual GitHub production workflow exposes the same choice as **Debug
measurements**. Its default is off.

The response can include these measurements:

| Name           | Meaning                                                 |
| -------------- | ------------------------------------------------------- |
| `doxa_resolve` | Hostname resolution, including the hostname-cache call. |
| `doxa_html`    | The version-specific HTML-cache call.                   |
| `doxa_loader`  | Dynamic Worker lookup, startup, and render dispatch.    |
| `doxa_code`    | Renderer package loading on a cold Dynamic Worker.      |
| `doxa_render`  | Shared or Dynamic Worker rendering.                     |
| `doxa_total`   | Total time inside the public dispatcher.                |

Descriptions on the timing entries identify hostname and HTML cache status,
shared versus dynamic rendering, and `WARM` versus `COLD` Dynamic Worker
loading. A cold load also includes `doxa_code`.

The structured log records the hostname, method, status, renderer mode, cache
statuses, Cloudflare location when available, and the timing values. Doxa does
not write these measurements to PostgreSQL, R2, or KV. Cloudflare stores the log
under the Worker's normal observability retention policy.

An HTML cache fill keeps its renderer measurements in a private internal
header until the public dispatcher receives it. The dispatcher exposes those
measurements only for a fresh `MISS` or `BYPASS`, then removes the internal
header. A cache `HIT` reports only work done for the current request, so an old
render duration is never shown as current data.

## Shared Renderer

`doxa-docs-renderer-shared` is not public. The dispatcher calls it through a
service binding.

The shared renderer reads content through `RuntimeSourceApi`. It sends the
request hostname to that private RPC. The runtime resolves the current version
and reads its artifacts.

The shared renderer handles:

- every pull-request preview;
- every permanent generation URL;
- all traffic while dynamic mode is off;
- safe fallback requests.

A hostname that the dispatcher cannot resolve also reaches the shared
renderer. When the runtime answers `project_not_found` (no published docs for
the hostname), the renderer returns `404` with a short static page (plain
text for a request that does not accept HTML) and `Cache-Control: no-store`
(`apps/docs-template/src/lib/no-published-docs.ts`). It shows no site data and
no error details. Every other runtime error still fails the request with a
5xx.

## Dynamic Worker Security

The dispatcher resolves one exact production version before it creates the
Dynamic Worker.

The child gets only:

- public renderer settings;
- the exact site, project, version, manifest, and artifact prefix;
- a scoped content RPC.

The scoped RPC replaces the version data on every call. The child cannot select
another project or artifact prefix.

The child does not get:

- an R2 binding;
- a database binding;
- the API service binding;
- an API token;
- global network access.

`globalOutbound` is `null`.

## Renderer Code Package

The deployment builds the docs template once. It packages all server JavaScript
modules in one gzip file.

The package builder:

- checks every relative module import;
- creates a SHA-256 build ID from the code;
- rejects more than 25 MiB before compression;
- rejects more than 10 MiB after compression;
- writes the build ID into the dispatcher config.

The deployment uploads the package to:

```text
doxa-docs-renderer-code/renderer-code/{buildId}.json.gz
```

The `doxa-docs-renderer-code` R2 bucket must exist before the first deployment.

## Search

Search runs on the renderer, not in the browser.

Publishing writes two artifacts:

- `search/index.json` contains the source documents.
- `search/minisearch.json` contains the built MiniSearch index.

The browser calls `GET /api/search`. It does not download or build the full
search index.

The renderer first reads the built index. Older versions can still use
`search/index.json`. The runtime also supports the older three-field search
artifact, so existing published docs remain searchable.

Production and preview search use the same server endpoint. Their renderer
routing remains different.

## Version Images

Pages link to images of their version with `/assets/{name}`, for example
`/assets/rate-limits-diagram.png`. Agents upload them with the MCP tool
`upload_asset`; a publish or a preview build copies them into the version at
`assets/{name}`. The name is a lowercase slug with the extension `png`,
`jpg`, `webp`, `gif`, or `svg` (`docsAssetFileNameSchema` in
`@doxahq/contracts/docs-assets`).

1. The dispatcher (`apps/docs-dispatcher/src/version-assets.ts`) serves a
   public site through `DOCS_RUNTIME.versionAsset`. It leaves a private site
   to the renderer, so the access gate runs first.
2. The renderer (`tryVersionAssetResponse` in `apps/docs-template/src/server.ts`)
   asks its runtime source: the `versionAsset` binding method, or
   `/runtime-source/version-assets/{name}` in platform mode.
3. The runtime (`apps/docs-runtime/src/version-assets.ts`) reads
   `{artifactPrefix}/assets/{name}` of the resolved version through the tree
   reader, only when the prefix is a version folder of the resolved site.

A miss passes the request on, so a renderer file of the same shape still
reaches the renderer. The response has the type of the name's extension,
`X-Content-Type-Options: nosniff`, `public, max-age=300` for a public site
(the same path can hold another image in a later version) or
`private, no-store`, and a sandbox CSP for SVG.

Deploy the docs runtime before the renderer and the dispatcher. Until then,
both pass the request on, and the image answers 404.

## Deployment Order

`pnpm deploy:docs-template` uses this order:

1. Read the release record `renderer-code/releases/current.json` from the
   renderer code bucket (skipped with `--dry-run`).
2. Build the shared renderer and client assets.
3. Validate and compress the server module graph, and plan the previous
   build from the record and `--previous-fallback`.
4. Upload the client assets to `client-assets/v1/assets/` in the renderer code
   bucket, for pages loaded before this deploy. A dry run stops before this
   step. See [Old client assets](production-docs-content-injection.md#old-client-assets).
5. Deploy the shared fallback.
6. Upload the immutable code package.
7. Deploy the public dispatcher with the selected mode and the previous build.
8. Write the new release record.
9. Deploy the pre-render Worker and the API.

The production GitHub Action defaults to `all`. It exposes the mode and
allowlist as manual inputs for a controlled rollback.

## Main Files

- `apps/docs-dispatcher/src/index.ts`
- `apps/docs-dispatcher/src/dispatcher.ts`
- `apps/docs-dispatcher/src/routing-policy.ts`
- `apps/docs-dispatcher/src/renderer-code-package.ts`
- `apps/docs-dispatcher/src/server-timing.ts`
- `apps/docs-dispatcher/scripts/package-renderer.mjs`
- `apps/docs-template/wrangler.renderer.shared.production.json`
- `apps/docs-runtime/src/runtime-source.ts`
- `packages/docs-search/src/index.ts`
- `apps/docs-template/src/routes/api.search.ts`
