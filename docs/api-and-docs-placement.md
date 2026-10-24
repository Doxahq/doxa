# API and docs database placement

## Purpose

PlanetScale is in AWS `us-east-1`. Production API HTTP requests and private docs resolution use `placement.region = "aws:us-east-1"`. Cloudflare selects a nearby execution location with low latency to that region. This is not a guarantee of one fixed data center.

The dashboard frontend, docs dispatcher, shared renderer, Dynamic Workers, and docs content runtime keep their existing edge placement. Generation RPC, scheduled handlers, and queues are outside this change.

## Request paths

Dashboard requests go to the public API. The API checks authentication and project access, then queries PlanetScale nearby. The dashboard does not call the docs resolver. Browser query caching is unchanged.

Production docs resolution uses `DOCS_RESOLVER.fetch()` on the private `doxa-docs-resolver-production` Worker. The Worker owns a default fetch handler because Cloudflare placement does not affect named entrypoints or custom RPC methods.

The resolver supports only hostname, project ID, and project slug resolution. It shares the existing API repositories and hostname resolver. It returns version metadata, not HTML or artifacts. It does not accept caller-selected artifact prefixes.

The dispatcher still consults its hostname cache before it selects the version-specific HTML cache. A valid hostname cache entry avoids resolution. After that entry expires, a lookup can be necessary even if HTML for the resolved version remains cached.

- Hostname cache policy remains 5 seconds for public production resolutions.
- HTML cache policy remains 24 hours, scoped by hostname, version, and renderer build.
- Preview, authenticated, and otherwise uncacheable requests retain their existing bypass rules.
- The private resolver returns `Cache-Control: no-store`. It adds no second cache.
- Existing publication/domain invalidation remains on the dispatcher's `DocsHostCache` entrypoint.
- Resolved Dynamic Worker content requests stay pinned to the selected version and do not query the resolver again.

Shared-renderer content requests use the same private resolver through the runtime when they need hostname/project resolution. Artifact reads and rendering stay outside the database region placement.

## Security and failures

The resolver has no public route, workers.dev address, or preview URL. Trusted platform Workers reach it through a default-fetch service binding. Dynamic renderers do not receive this binding.

Its only resource binding is `HYPERDRIVE_CACHE_DISABLED`, using the same fresh-read configuration as the API. It has no R2, authentication, queue, or generation bindings. Existing database access rules still apply; a private service is not a replacement for project/version isolation.

An unknown record returns `{ "resolution": null }`. A database failure returns HTTP 503 with no-store headers. The client rejects invalid responses and failed requests. Requests use a 10-second abort deadline. A configured resolver never silently falls back to legacy RPC or public HTTP resolution.

The dispatcher's existing shared-renderer fallback remains. Shared rendering still uses the resolver through the runtime, so this fallback does not bypass failed resolution or serve a different unverified project.

`GET /health` is a private liveness endpoint. It does not query the database or prove that deployment bindings work.

## Local development

Normal `pnpm dev` is unchanged. It uses existing local API RPC/HTTP resolution when no `DOCS_RESOLVER` binding exists. Production validation requires the binding. Local tests exercise the new HTTP client and handler without Cloudflare or database access.

The alternate Wrangler configuration can also run locally for resolver diagnostics:

```sh
pnpm --filter @doxahq/api exec wrangler dev --config wrangler.docs-resolver.json --port 8790
```

This optional process requires the local database. It is not part of the normal dev stack, and local execution does not simulate regional placement.

## Deployment

No migration or new secret is required. The resolver builds from `apps/api` using `wrangler.docs-resolver.json`; it is a separate deployed Worker, not a duplicate API.

Both `pnpm deploy:all` and the manual GitHub production workflow deploy the resolver before the runtime and dispatcher. Production validation checks placement, private-only access, fresh Hyperdrive configuration, matching docs policy, and default-fetch bindings. The renderer deploy script also rejects a named-entrypoint resolver binding.

For a targeted rollout, after the normal checks and explicit deployment approval:

```sh
pnpm validate:production-config
pnpm deploy:api
pnpm deploy:docs-resolver
pnpm deploy:docs-runtime
pnpm deploy:docs-template -- --skip-secret
```

The renderer command deploys its existing shared-renderer/dispatcher bundle. The dashboard and generation services do not need a new deployment for this change.

Keep `DOCS_BASE_DOMAIN` and `DOCS_PREVIEW_GATE_ENABLED` consistent between the API and resolver. The validator catches configuration-file drift. Do not change these independently through the Cloudflare dashboard.

## Production verification after deployment

1. Inspect API `cf-placement` and Cloudflare execution traces to confirm regional placement. Record execution location separately from the visitor's ingress location.
2. Confirm the private resolver invocation occurs on a docs hostname-cache miss, and inspect its execution location.
3. Confirm cached docs retain expected `x-doxa-host-cache`, `x-doxa-html-cache`, and `x-doxa-renderer-mode` headers.
4. Compare cold and warm requests from Australia, Japan, and US East. Do not label a fresh browser as a cold CDN cache.
5. Verify custom domains, generated production domains, PR previews, and permanent generation URLs.
6. Promote a generation and verify the existing invalidation flow selects the new published version.
7. Verify dashboard login and project operations. Existing auth and authorization rules must remain intact.

Local tests and dry runs prove code/configuration compatibility, not actual placement, remote bindings, or a specific latency improvement.

## Rollback

Roll back the dispatcher and runtime to their pre-resolver versions together, restoring their previous service bindings. Roll back the API if its placement causes a regression. Leave the private resolver deployed but unused until no consumer references it. No data rollback is needed.

For a source-level rollback, revert this change as a unit, including the placement validator and deployment wiring. Removing only the placement setting intentionally fails validation.

## References

- [Cloudflare Worker placement and limitations](https://developers.cloudflare.com/workers/configuration/placement/)
- [Cloudflare service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
