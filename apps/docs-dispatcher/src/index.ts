import {
  docsCacheInvalidationSchema,
  type DocsCacheInvalidation,
  type DocsDomainResolution,
  type DocsHostResolution,
} from "@doxahq/contracts";
import { limitDocsRequest, type DocsRequestLimitEnv } from "./request-limit";
import {
  parseDocsCspMode,
  withDocsContentSecurityPolicy,
  type DocsCspEnv,
} from "./content-security-policy";
import { handleCspReport, isCspReportRequest } from "./csp-report";
import {
  parsePublicDocsRouteDataV1,
  type PublicDocsRouteDataV1,
} from "@doxahq/contracts/docs-prerender";
import {
  DocsResolverClient,
  type DocsResolverBinding,
} from "@doxahq/contracts/docs-resolver";
import type { DocsHostnameMapSync } from "@doxahq/contracts/docs-hostname-map";
import type { DocsWarmStatus } from "@doxahq/contracts/docs-warm-job";
import { WorkerEntrypoint } from "cloudflare:workers";

import {
  createDocsCacheTags,
  isCacheableDocsRequest,
  isContentCacheLifetime,
  isPrerenderableDocsRequest,
  isPublicProduction,
  withHostCachePolicy,
  withHtmlCachePolicy,
  withoutResponseCaching,
  type HostCacheProps,
  type HtmlCacheProps,
} from "./cache-policy";
import { createCanonicalHostRedirect } from "./canonical-host-redirect";
import {
  handleClientAssetFallback,
  parseClientAssetFallbackMode,
  type ClientAssetFallbackEnv,
} from "./client-asset-fallback";
import { dispatchDocsRequest } from "./dispatcher";
import { runEdgeGateway } from "./edge-gateway";
import type { HttpsPolicyEnv } from "./https-policy";
import { toHostResolution } from "./host-resolution";
import {
  lookupHost,
  readHostCache,
  setHostDiagnostics,
  type HostLookupFacts,
} from "./host-lookup";
import { parseHostnameMapMode } from "./hostname-map";
import { requireEnvValue } from "./env-values";
import {
  observeResponseBody,
  takeRendererTiming,
  toIsolateFacts,
  toRenderPhases,
} from "./renderer-timing";
import {
  logRendererUse,
  openRendererIsolate,
  type RendererCallOutcome,
  type RendererEntrypointName,
  type RendererIsolateEnv,
} from "./renderer-isolate";
import {
  readDeliveryRollouts,
  resolveActiveDelivery,
  type DeliveryRolloutEnv,
} from "./delivery-identity";
import type { PrerenderRepairTasksRpc } from "./prerender-cache-entrypoint";
import {
  applyPrerenderDiagnostics,
  tryPrerenderedHtml,
  type PrerenderAttemptDiagnostics,
} from "./prerender-routing";
import {
  tryPreviousBuildHtml,
  type FallbackFacts,
  type PreviousFallbackContext,
  type PreviousFallbackEnv,
} from "./previous-build-fallback";
import { readPreviousRendererBuild } from "./previous-renderer-build";
import {
  createHtmlCacheCall,
  fetchPublicCacheCall,
  INTERNAL_RENDER_ID_HEADER,
} from "./public-cache-calls";
import { parseSiteAllowlist } from "./rollout-policy";
import { parseRendererMode } from "./routing-policy";
import {
  applyRouteDataBrowserCachePolicy,
  readRouteDataBrowserCacheRollout,
  type RouteDataBrowserCacheEnv,
} from "./route-data-browser-cache";
import { handleRouteDataEndpoint } from "./route-data-endpoint";
import {
  planPathnameRouteDataPrefetch,
  planRouteDataPrefetch,
  readRouteDataPrefetchRollout,
  routeDataPrefetches,
  type RouteDataPrefetchEnv,
  type RouteDataPrefetchPlan,
  type RouteDataPrefetchReport,
} from "./route-data-prefetch";
import { ROUTE_DATA_PATH } from "./route-data-request";
import { createRuntimeTrace, requestDocsRuntime } from "./runtime-trace";
import {
  withDocsPreviewSearchPolicy,
  withDocsSecurityHeaders,
} from "./security-headers";
import { handleSiteAssetRequest } from "./site-assets";
import {
  DocsTextCacheEntrypoint,
  fetchDocsTextFromCache,
  type DocsTextRenderInput,
} from "./text-cache-entrypoint";
import {
  readTextRouteCacheRollout,
  selectDocsTextCacheRoute,
  type TextRouteCacheEnv,
} from "./text-cache-policy";
import { handleVersionAssetRequest } from "./version-assets";
import type { WarmEnv } from "./warm/warm-env";
import {
  handleWarmQueue,
  handleWarmSchedule,
  readWarmStatus,
  syncHostnamesWithWarm,
} from "./warm/warm-handlers";
import {
  fetchWithoutProbeMarker,
  serveVersionedEntrypoint,
  withoutCacheProbeMarker,
} from "./versioned-entrypoint-protocol";
import {
  attachInternalServerTiming,
  createServerTiming,
  exposeRequestTiming,
  logRequestTiming,
  type ServerTimingRecorder,
} from "./server-timing";
import {
  getWorkerExports,
  type DocsRuntimeRpc,
  type RuntimeRequest,
  type RuntimeResponse,
  type ScopedDocsContentProps,
} from "./worker-exports";

export { DocsPrerenderCache } from "./prerender-cache-entrypoint";
export { DocsRouteDataCache } from "./route-data-cache-entrypoint";
export { DocsRendererCodeCache } from "./renderer-code-cache-entrypoint";
export { DocsClientAssetCache } from "./client-asset-cache-entrypoint";
export { DocsWarmLock } from "./warm/docs-warm-lock";
export { DocsWarmAnchor } from "./warm/docs-warm-anchor";
export { DocsRegionalWarmer } from "./warm/docs-regional-warmer";
export { DocsWarmControl } from "./warm/docs-warm-control";

interface DispatcherEnv
  extends DeliveryRolloutEnv,
    HttpsPolicyEnv,
    RendererIsolateEnv,
    RouteDataBrowserCacheEnv,
    RouteDataPrefetchEnv,
    TextRouteCacheEnv,
    ClientAssetFallbackEnv,
    PreviousFallbackEnv,
    DocsRequestLimitEnv,
    DocsCspEnv,
    WarmEnv {
  DEBUG?: string;
  DOCS_RESOLVER: DocsResolverBinding;
  DOCS_RUNTIME: DocsRuntimeRpc;
  SHARED_RENDERER: Fetcher;
  DOCS_RENDERED_BUCKET?: R2Bucket;
  PRERENDER_TASKS?: PrerenderRepairTasksRpc;
  DOXA_PROD_DYNAMIC_RENDERER_MODE?: string;
  DOXA_PROD_DYNAMIC_RENDERER_SITE_IDS?: string;
  DOXA_RENDERER_RELEASE_ID?: string;
  DOXA_PRERENDER_REPAIR_ENABLED?: string;
  /** Workers KV hostname map. Optional: without it every lookup misses. */
  DOCS_HOSTNAME_MAP?: KVNamespace;
  DOXA_PROD_KV_HOSTNAME_MODE?: string;
}

/** Workers Cache caches fetch entrypoints, not custom RPC methods. */
export class DocsHostCache extends WorkerEntrypoint<
  DispatcherEnv,
  HostCacheProps
> {
  // The API binds directly to this named entrypoint. The public gateway exposes
  // no purge route, and the dynamic renderer receives no invalidation binding.
  async invalidate(input: DocsCacheInvalidation): Promise<void> {
    const target = docsCacheInvalidationSchema.parse(input);
    if (!this.ctx.cache) throw new Error("Workers Cache is unavailable");
    const result = await this.ctx.cache.purge({
      tags: createDocsCacheTags(target),
    });
    if (!result.success) throw new Error("Workers Cache purge failed");
  }

  // The API sends entries that it computed from the database. Without the
  // namespace binding the map is not provisioned, and every read misses too.
  // A changed live version also starts the regional warm job (M28).
  async syncHostnames(input: DocsHostnameMapSync): Promise<void> {
    if (!this.env.DOCS_HOSTNAME_MAP) return;
    await syncHostnamesWithWarm(this.env.DOCS_HOSTNAME_MAP, input, this.env);
  }

  /** M45b: per-pool warm progress of a site; the API checks ownership. */
  async getWarmStatus(input: { siteId: string }): Promise<DocsWarmStatus> {
    return readWarmStatus(this.env, input);
  }

  async fetch(): Promise<Response> {
    return withHostCachePolicy(
      await new DocsResolverClient(this.env.DOCS_RESOLVER).resolveDocsHost(
        this.ctx.props.hostname,
      ),
    );
  }
}

/** Only the dispatcher supplies these props; the hostname alone is not a cache key. */
export class DocsHtmlCache extends WorkerEntrypoint<
  DispatcherEnv,
  HtmlCacheProps
> {
  async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props;
    return serveVersionedEntrypoint({
      entrypoint: "DocsHtmlCache",
      request,
      props,
      build: {
        requested: props.rendererBuildId,
        deployed: this.env.DOXA_RENDERER_BUILD_ID ?? null,
        previous: readPreviousRendererBuild(this.env)?.buildId ?? null,
      },
      isTrusted: () => isTrustedHtmlCacheRequest(request, props),
      rejection: "Invalid cache request",
      fill: async () => {
        const timing = createServerTiming(this.env.DEBUG);
        const rendered = await renderWithDynamicWorker(
          request,
          props.resolution,
          this.env,
          this.ctx,
          timing,
        );
        return attachInternalServerTiming(
          withHtmlCachePolicy(rendered, props.lifetime),
          timing,
        );
      },
    });
  }
}

/** Caches `/llms.txt`, `/llms-full.txt` and `/{path}.md` of public production sites. */
export class DocsTextCache extends DocsTextCacheEntrypoint<DispatcherEnv> {
  protected render(input: DocsTextRenderInput): Promise<Response> {
    return renderWithDynamicWorker(
      input.request,
      input.resolution,
      this.env,
      this.ctx,
      input.timing,
    );
  }
}

/** The build check is part of the entrypoint protocol, not of this check. */
function isTrustedHtmlCacheRequest(
  request: Request,
  props: HtmlCacheProps,
): boolean {
  const { hostname, resolution, lifetime, deliveryRenderId } = props;
  return (
    isCacheableDocsRequest(request) &&
    isPublicProduction(resolution) &&
    hostname === new URL(request.url).hostname &&
    resolution.hostname === hostname &&
    isContentCacheLifetime(lifetime) &&
    // The HTML embeds this ID, so the key must contain the same value.
    readInternalRenderId(request) === deliveryRenderId
  );
}

/** Narrow private RPC facade over the approved immutable renderer package. */
export class PrerenderRendererApi extends WorkerEntrypoint<DispatcherEnv> {
  async getPlan(input: { resolution: DocsHostResolution }): Promise<unknown> {
    const result = await this.env.DOCS_RUNTIME.request({
      resolution: input.resolution,
      operation: "getPrerenderPlan",
      trace: createRuntimeTrace("plan"),
    });
    if (!result.ok)
      throw new Error("The docs runtime could not build a pre-render plan.");
    return result.data;
  }

  async prepare(input: {
    resolution: DocsHostResolution;
    pathname: string;
  }): Promise<PublicDocsRouteDataV1> {
    return withPrivatePrerenderRenderer(
      {
        resolution: input.resolution,
        env: this.env,
        ctx: this.ctx,
        entrypoint: "prepare",
        prefetchRouteDataFor: input.pathname,
      },
      async (renderer) =>
        parsePublicDocsRouteDataV1(
          await renderer.prepare({ pathname: input.pathname }),
        ),
    );
  }

  async render(input: {
    resolution: DocsHostResolution;
    pathname: string;
    requestUrl: string;
    renderId: string;
    routeData: PublicDocsRouteDataV1;
  }): Promise<Response> {
    return withPrivatePrerenderRenderer(
      {
        resolution: input.resolution,
        env: this.env,
        ctx: this.ctx,
        entrypoint: "render",
      },
      (renderer) =>
        renderer.render({
          pathname: input.pathname,
          requestUrl: input.requestUrl,
          renderId: input.renderId,
          routeData: parsePublicDocsRouteDataV1(input.routeData),
        }),
    );
  }
}

/**
 * The dynamic renderer receives this narrow RPC binding instead of storage,
 * API, or token access. The dispatcher pins every operation to one version.
 */
export class ScopedDocsContent extends WorkerEntrypoint<
  DispatcherEnv,
  ScopedDocsContentProps
> {
  asset(input: { hash: string }): Promise<Response> {
    if (!this.env.DOCS_RUNTIME.asset)
      return Promise.resolve(new Response(null, { status: 503 }));
    return this.env.DOCS_RUNTIME.asset({
      resolution: this.ctx.props.resolution,
      hash: input.hash,
    });
  }

  versionAsset(input: {
    name: string;
    version?: string | null;
  }): Promise<Response> {
    if (!this.env.DOCS_RUNTIME.versionAsset)
      return Promise.resolve(new Response(null, { status: 503 }));
    return this.env.DOCS_RUNTIME.versionAsset({
      resolution: this.ctx.props.resolution,
      name: input.name,
      ...(input.version ? { version: input.version } : {}),
    });
  }

  request(input: RuntimeRequest): Promise<RuntimeResponse> {
    const { resolution, routeDataPrefetchId } = this.ctx.props;
    // A prefetched answer is only ever the answer to this same call, pinned
    // to this same resolution. The trace is made here, never taken from input.
    return routeDataPrefetches.serve(
      routeDataPrefetchId,
      resolution,
      input,
      () =>
        requestDocsRuntime(
          this.env.DOCS_RUNTIME,
          { resolution, operation: input.operation, payload: input.payload },
          "content",
        ),
    );
  }
}

export default {
  fetch: (
    request: Request,
    env: DispatcherEnv,
    ctx: ExecutionContext,
  ): Promise<Response> =>
    runEdgeGateway(request, env, async (trusted) =>
      withDocsContentSecurityPolicy(
        await docsGateway.fetch(trusted, env, ctx),
        parseDocsCspMode(env.DOXA_PROD_DOCS_CSP_MODE),
      ),
    ),
  // The regional warm job (M28): both warm queues and the 5-minute sweep.
  queue: (batch: MessageBatch, env: DispatcherEnv): Promise<void> =>
    handleWarmQueue(batch, env),
  scheduled: (_controller: ScheduledController, env: DispatcherEnv): Promise<void> =>
    handleWarmSchedule(env),
} satisfies ExportedHandler<DispatcherEnv>;

/** Routing of one request; `runEdgeGateway` has stripped its internal headers. */
const docsGateway = {
  async fetch(
    request: Request,
    env: DispatcherEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Old hashed client files that the static ASSETS binding no longer has.
    const clientAsset = await handleClientAssetFallback(request, {
      mode: parseClientAssetFallbackMode(
        env.DOXA_PROD_CLIENT_ASSET_FALLBACK_MODE,
      ),
      cache: () => getWorkerExports(ctx).DocsClientAssetCache,
    });
    if (clientAsset) return clientAsset;

    const limited = await limitDocsRequest(request, env);
    if (limited) return limited;
    if (isCspReportRequest(request)) return handleCspReport(request);

    const timing = createServerTiming(env.DEBUG);
    const mode = parseRendererMode(env.DOXA_PROD_DYNAMIC_RENDERER_MODE);
    const allowedSiteIds = parseSiteAllowlist(
      env.DOXA_PROD_DYNAMIC_RENDERER_SITE_IDS,
    );
    const rollouts = readDeliveryRollouts(env);
    const hostnameMapMode = parseHostnameMapMode(
      env.DOXA_PROD_KV_HOSTNAME_MODE,
    );

    const cacheable = isCacheableDocsRequest(request);
    const prerenderable = isPrerenderableDocsRequest(request);
    const isRouteDataEndpoint =
      new URL(request.url).pathname === ROUTE_DATA_PATH;
    let hostCacheStatus = "BYPASS";
    let htmlCacheStatus = "BYPASS";
    let usedHtmlCache = false;
    let prerenderFallback = false;
    let prerenderDiagnostics: PrerenderAttemptDiagnostics | null = null;
    let fallback: FallbackFacts | null = null;
    let resolvedHost: DocsDomainResolution | null | undefined;
    let hostLookup: HostLookupFacts | undefined;
    const resolveHost = (hostname: string) =>
      timing.measure(
        "doxa_resolve",
        async () => {
          if (resolvedHost !== undefined) return resolvedHost;
          const lookup = await lookupHost({
            hostname,
            mode: hostnameMapMode,
            store: env.DOCS_HOSTNAME_MAP,
            now: Date.now(),
            readHostCache: () => readHostCache(ctx, hostname),
          });
          hostLookup = lookup.facts;
          hostCacheStatus = lookup.facts.hostCacheStatus;
          resolvedHost = lookup.resolution;
          return resolvedHost;
        },
        () => (hostLookup?.source === "kv" ? "KV" : hostCacheStatus),
      );
    const findDeliveryRenderId = async (
      deliveryRequest: Request,
      resolution: DocsDomainResolution | null | undefined,
    ) =>
      (await resolveActiveDelivery(deliveryRequest, resolution, env, rollouts))
        ?.identity.renderId;
    const deliveryContext = {
      request,
      env,
      ctx,
      rollouts,
      timing,
      resolveHost,
    };

    // Route data is internal JSON for the pages of the same host, which a
    // redirecting host never serves: it keeps its own lookup rules.
    if (!isRouteDataEndpoint) {
      const canonicalRedirect = createCanonicalHostRedirect(
        request,
        await resolveHostOrNull(resolveHost, request),
      );
      if (canonicalRedirect) return canonicalRedirect;
    }

    const assetResponse =
      (await handleSiteAssetRequest(request, {
        resolveHost,
        runtime: env.DOCS_RUNTIME,
        privateRenderer: env.SHARED_RENDERER,
      })) ??
      (await handleVersionAssetRequest(request, {
        resolveHost,
        runtime: env.DOCS_RUNTIME,
      }));
    if (assetResponse) {
      return withDocsPreviewSearchPolicy(assetResponse, resolvedHost);
    }

    if (isRouteDataEndpoint) {
      const routeData = await handleRouteDataEndpoint(deliveryContext);
      const result = withDocsPreviewSearchPolicy(
        applyRouteDataBrowserCachePolicy(
          withDocsSecurityHeaders(withoutResponseCaching(routeData.response)),
          {
            request,
            hintMatched: routeData.hintMatched,
            resolution: resolvedHost,
            rollout: readRouteDataBrowserCacheRollout(env),
          },
        ),
        resolvedHost,
      );
      setHostDiagnostics(result.headers, hostCacheStatus, hostLookup);
      result.headers.set("x-doxa-route-data-cache", routeData.cacheStatus);
      exposeRequestTiming(result, result, timing, {
        usedHtmlCache: false,
        htmlCacheStatus: "BYPASS",
      });
      logRequestTiming(request, result, timing, {
        hostCacheStatus,
        htmlCacheStatus: "BYPASS",
        routeDataCacheStatus: routeData.cacheStatus,
        hostLookup,
      });
      return result;
    }

    const fallbackContext = (): PreviousFallbackContext => ({
      env,
      ctx,
      exports: getWorkerExports(ctx),
      now: Date.now(),
    });

    if (prerenderable && rollouts.prerender.mode !== "off") {
      const saved = await tryPrerenderedHtml(deliveryContext);
      prerenderDiagnostics = saved.diagnostics;
      let savedResponse = saved.response;
      let savedStatus = "PRERENDER";
      // F16: only after a real saved-output 404, probe the previous build's
      // saved output before the live fallback.
      if (!savedResponse && saved.eligible && resolvedHost) {
        const previous = await tryPreviousBuildHtml(fallbackContext(), {
          request,
          resolution: resolvedHost,
          cf: request.cf,
        });
        fallback = previous.facts;
        savedResponse = previous.response;
        savedStatus = "PREVIOUS";
      }
      if (savedResponse) {
        const result = withDocsPreviewSearchPolicy(
          withDocsSecurityHeaders(withoutResponseCaching(savedResponse)),
          resolvedHost,
        );
        setHostDiagnostics(result.headers, hostCacheStatus, hostLookup);
        result.headers.set("x-doxa-html-cache", savedStatus);
        if (prerenderDiagnostics) {
          applyPrerenderDiagnostics(result, prerenderDiagnostics, timing);
        }
        exposeRequestTiming(result, savedResponse, timing, {
          usedHtmlCache: false,
          htmlCacheStatus: savedStatus,
        });
        logRequestTiming(request, result, timing, {
          hostCacheStatus,
          htmlCacheStatus: savedStatus,
          hostLookup,
          fallback,
        });
        return result;
      }
      prerenderFallback = saved.eligible;
    }
    const response = await timing.measure("doxa_total", () =>
      dispatchDocsRequest({
        request,
        mode,
        allowedSiteIds,
        resolveHost,
        renderShared: async (sharedRequest) =>
          timing.measure(
            "doxa_render",
            async () =>
              env.SHARED_RENDERER.fetch(
                withInternalRenderId(
                  sharedRequest,
                  await findDeliveryRenderId(sharedRequest, resolvedHost),
                ),
              ),
            "SHARED",
          ),
        renderDynamic: async (dynamicRequest, resolution) => {
          const deliveryRenderId = await findDeliveryRenderId(
            dynamicRequest,
            resolution,
          );
          const pinnedRequest = withInternalRenderId(
            dynamicRequest,
            deliveryRenderId,
          );
          const textRoute = selectDocsTextCacheRoute(
            pinnedRequest,
            resolution,
            readTextRouteCacheRollout(env),
          );
          if (textRoute) {
            return fetchDocsTextFromCache({
              request: pinnedRequest,
              resolution,
              route: textRoute,
              rendererBuildId: requireEnvValue(
                env.DOXA_RENDERER_BUILD_ID,
                "DOXA_RENDERER_BUILD_ID",
              ),
              deliveryRenderId: deliveryRenderId ?? null,
              cache: getWorkerExports(ctx).DocsTextCache,
            });
          }
          if (!cacheable || !isPublicProduction(resolution)) {
            return renderWithDynamicWorker(
              pinnedRequest,
              resolution,
              env,
              ctx,
              timing,
            );
          }
          usedHtmlCache = true;
          const lifetime = prerenderFallback ? "liveFallback" : "versioned";
          // A live fallback for saved output already probed the previous
          // build's saved output above.
          if (lifetime === "versioned") {
            const previous = await tryPreviousBuildHtml(fallbackContext(), {
              request: dynamicRequest,
              resolution,
              cf: request.cf,
            });
            fallback = previous.facts;
            if (previous.response) {
              htmlCacheStatus = "PREVIOUS";
              return previous.response;
            }
          }
          const call = createHtmlCacheCall({
            url: pinnedRequest.url,
            method: pinnedRequest.method === "HEAD" ? "HEAD" : "GET",
            resolution,
            rendererBuildId: requireEnvValue(
              env.DOXA_RENDERER_BUILD_ID,
              "DOXA_RENDERER_BUILD_ID",
            ),
            deliveryRenderId: deliveryRenderId ?? null,
            lifetime,
          });
          return timing.measure(
            "doxa_html",
            async () => {
              const cached = await fetchWithoutProbeMarker("DocsHtmlCache", () =>
                fetchPublicCacheCall(getWorkerExports(ctx), call),
              );
              if (!cached) {
                // Not filled twice: render without the cache.
                htmlCacheStatus = "BYPASS";
                return renderWithDynamicWorker(
                  pinnedRequest,
                  resolution,
                  env,
                  ctx,
                  timing,
                );
              }
              htmlCacheStatus =
                cached.headers.get("cf-cache-status") ?? "UNAVAILABLE";
              return cached;
            },
            () => htmlCacheStatus,
          );
        },
      }),
    );
    // The default cache key omits hostname and version. Never cache this gateway,
    // including shared fallback responses which resolve their version separately.
    const result = withDocsPreviewSearchPolicy(
      withDocsSecurityHeaders(
        withoutResponseCaching(withoutCacheProbeMarker(response)),
      ),
      resolvedHost,
    );
    if (!result.headers.has("x-doxa-representation-source")) {
      result.headers.set(
        "x-doxa-representation-source",
        result.headers.get("x-doxa-renderer-mode") === "dynamic"
          ? "dynamic"
          : "shared",
      );
    }
    setHostDiagnostics(result.headers, hostCacheStatus, hostLookup);
    result.headers.set("x-doxa-html-cache", htmlCacheStatus);
    if (prerenderDiagnostics) {
      applyPrerenderDiagnostics(result, prerenderDiagnostics, timing);
    }
    exposeRequestTiming(result, response, timing, {
      usedHtmlCache,
      htmlCacheStatus,
    });
    logRequestTiming(request, result, timing, {
      hostCacheStatus,
      htmlCacheStatus,
      hostLookup,
      fallback,
    });
    return result;
  },
};

/** The host resolution, or null when the lookup fails: routing continues. */
async function resolveHostOrNull(
  resolveHost: (hostname: string) => Promise<DocsDomainResolution | null>,
  request: Request,
): Promise<DocsDomainResolution | null> {
  try {
    return await resolveHost(new URL(request.url).hostname);
  } catch {
    return null;
  }
}

function withInternalRenderId(request: Request, renderId?: string): Request {
  const headers = new Headers(request.headers);
  headers.delete(INTERNAL_RENDER_ID_HEADER);
  if (renderId) headers.set(INTERNAL_RENDER_ID_HEADER, renderId);
  return new Request(request, { headers });
}

function readInternalRenderId(request: Request): string | null {
  return request.headers.get(INTERNAL_RENDER_ID_HEADER);
}

async function renderWithDynamicWorker(
  request: Request,
  resolution: DocsDomainResolution,
  env: DispatcherEnv,
  ctx: ExecutionContext,
  timing: ServerTimingRecorder,
): Promise<Response> {
  const hostResolution = toHostResolution(resolution);
  const prefetch = planRouteDataPrefetch({
    request,
    siteId: hostResolution.siteId,
    rollout: readRouteDataPrefetchRollout(env),
  });
  const isolate = openRendererIsolate({
    env,
    resolution: hostResolution,
    content: getWorkerExports(ctx).ScopedDocsContent({
      props: {
        resolution: hostResolution,
        ...(prefetch ? { routeDataPrefetchId: prefetch.id } : {}),
      },
    }),
    codeCache: getWorkerExports(ctx).DocsRendererCodeCache,
    timing,
    ...(prefetch
      ? {
          onColdStart: () =>
            startRouteDataPrefetch(prefetch, hostResolution, env, ctx),
        }
      : {}),
  });
  const takePrefetchReport = (): RouteDataPrefetchReport | undefined =>
    prefetch ? routeDataPrefetches.finish(prefetch.id) : undefined;
  const startedAt = Date.now();
  try {
    const rendered = await timing.measure(
      "doxa_loader",
      () =>
        timing.measure(
          "doxa_render",
          () => isolate.getEntrypoint().fetch(request),
          "DYNAMIC",
        ),
      () => (isolate.cold ? "COLD" : "WARM"),
    );
    const respondedAt = Date.now();
    const routeDataPrefetch = takePrefetchReport();
    const { response, report } = takeRendererTiming(rendered);
    return observeResponseBody(response, (body) =>
      logRendererUse(isolate, {
        entrypoint: "fetch",
        resolution: hostResolution,
        startedAt,
        finishedAt: respondedAt,
        outcome: { ok: response.ok, status: response.status },
        ...(report
          ? {
              phases: toRenderPhases({ report, calledAt: startedAt, respondedAt }),
              renderer: toIsolateFacts(report),
            }
          : {}),
        body,
        ...(routeDataPrefetch ? { routeDataPrefetch } : {}),
      }),
    );
  } catch (error) {
    const routeDataPrefetch = takePrefetchReport();
    logRendererUse(isolate, {
      entrypoint: "fetch",
      resolution: hostResolution,
      startedAt,
      outcome: { ok: false, error: describeError(error) },
      ...(routeDataPrefetch ? { routeDataPrefetch } : {}),
    });
    throw error;
  }
}

/**
 * Sends this render's `getRouteData` to docs-runtime while the renderer
 * starts. Runs only on a cold start, so a warm render never pays twice.
 */
function startRouteDataPrefetch(
  plan: RouteDataPrefetchPlan,
  resolution: DocsHostResolution,
  env: DispatcherEnv,
  ctx: ExecutionContext,
): void {
  ctx.waitUntil(
    routeDataPrefetches.start({ plan, runtime: env.DOCS_RUNTIME, resolution }),
  );
}

interface PrivatePrerenderRenderer {
  prepare(input: { pathname: string }): Promise<unknown>;
  render(input: {
    pathname: string;
    requestUrl: string;
    renderId: string;
    routeData: PublicDocsRouteDataV1;
  }): Promise<Response>;
}

/** Runs one call on the private pre-render entrypoint and logs the isolate use. */
async function withPrivatePrerenderRenderer<T>(
  input: {
    resolution: DocsHostResolution;
    env: DispatcherEnv;
    ctx: ExecutionContext;
    entrypoint: Exclude<RendererEntrypointName, "fetch">;
    /**
     * Only `prepare` sets it: that call always asks for the route data of
     * this pathname, so a cold start can prefetch it (M41).
     */
    prefetchRouteDataFor?: string;
  },
  call: (renderer: PrivatePrerenderRenderer) => Promise<T>,
): Promise<T> {
  const prefetch =
    input.prefetchRouteDataFor === undefined
      ? null
      : planPathnameRouteDataPrefetch({
          pathname: input.prefetchRouteDataFor,
          siteId: input.resolution.siteId,
          rollout: readRouteDataPrefetchRollout(input.env),
        });
  const isolate = openRendererIsolate({
    env: input.env,
    resolution: input.resolution,
    content: getWorkerExports(input.ctx).ScopedDocsContent({
      props: {
        resolution: input.resolution,
        ...(prefetch ? { routeDataPrefetchId: prefetch.id } : {}),
      },
    }),
    codeCache: getWorkerExports(input.ctx).DocsRendererCodeCache,
    timing: createServerTiming(input.env.DEBUG),
    ...(prefetch
      ? {
          onColdStart: () =>
            startRouteDataPrefetch(
              prefetch,
              input.resolution,
              input.env,
              input.ctx,
            ),
        }
      : {}),
  });
  const entrypoint: unknown = isolate.getEntrypoint("DocsPrerenderRenderer");
  if (!isPrivatePrerenderRenderer(entrypoint)) {
    throw new Error(
      "The renderer package has no private pre-render entrypoint.",
    );
  }
  const startedAt = Date.now();
  const log = (outcome: RendererCallOutcome) => {
    const routeDataPrefetch = prefetch
      ? routeDataPrefetches.finish(prefetch.id)
      : undefined;
    logRendererUse(isolate, {
      entrypoint: input.entrypoint,
      resolution: input.resolution,
      startedAt,
      outcome,
      ...(routeDataPrefetch ? { routeDataPrefetch } : {}),
    });
  };
  try {
    const result = await call(entrypoint);
    log({ ok: true });
    return result;
  } catch (error) {
    log({ ok: false, error: describeError(error) });
    throw error;
  }
}

function isPrivatePrerenderRenderer(
  value: unknown,
): value is PrivatePrerenderRenderer {
  return (
    typeof value === "object" &&
    value !== null &&
    "prepare" in value &&
    typeof value.prepare === "function" &&
    "render" in value &&
    typeof value.render === "function"
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error";
}
