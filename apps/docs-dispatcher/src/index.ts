import {
  docsDomainResolutionSchema,
  docsCacheInvalidationSchema,
  type DocsCacheInvalidation,
  type DocsDomainResolution,
  type DocsHostResolution,
} from "@doxahq/contracts";
import {
  parsePublicDocsRouteDataV1,
  type PublicDocsRouteDataV1,
} from "@doxahq/contracts/docs-prerender";
import {
  DocsResolverClient,
  type DocsResolverBinding,
} from "@doxahq/contracts/docs-resolver";
import { WorkerEntrypoint } from "cloudflare:workers";

import {
  createHtmlCacheProps,
  createDocsCacheTags,
  isCacheableDocsRequest,
  isContentCacheLifetime,
  isPrerenderableDocsRequest,
  isPublicProduction,
  withHostCachePolicy,
  withHtmlCachePolicy,
  withoutResponseCaching,
  type HtmlCacheProps,
} from "./cache-policy";
import { dispatchDocsRequest } from "./dispatcher";
import { toHostResolution } from "./host-resolution";
import { loadRendererCodePackage } from "./renderer-code-package";
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
import { parseSiteAllowlist } from "./rollout-policy";
import { createDynamicWorkerId, parseRendererMode } from "./routing-policy";
import { handleRouteDataEndpoint } from "./route-data-endpoint";
import { ROUTE_DATA_PATH } from "./route-data-request";
import {
  withDocsPreviewSearchPolicy,
  withDocsSecurityHeaders,
} from "./security-headers";
import { handleSiteAssetRequest } from "./site-assets";
import { handleVersionAssetRequest } from "./version-assets";
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

interface DispatcherEnv extends DeliveryRolloutEnv {
  DEBUG?: string;
  DOCS_RESOLVER: DocsResolverBinding;
  DOCS_RUNTIME: DocsRuntimeRpc;
  SHARED_RENDERER: Fetcher;
  LOADER: WorkerLoader;
  RENDERER_CODE_BUCKET: R2Bucket;
  DOCS_RENDERED_BUCKET?: R2Bucket;
  PRERENDER_TASKS?: PrerenderRepairTasksRpc;
  DOXA_PROD_DYNAMIC_RENDERER_MODE?: string;
  DOXA_PROD_DYNAMIC_RENDERER_SITE_IDS?: string;
  DOXA_RENDERER_BUILD_ID?: string;
  DOXA_RENDERER_PACKAGE_KEY?: string;
  DOXA_RENDERER_RELEASE_ID?: string;
  DOXA_PRERENDER_REPAIR_ENABLED?: string;
  DOXA_API_BASE_URL?: string;
  DOXA_DASHBOARD_BASE_URL?: string;
  DOXA_DOCS_BASE_DOMAIN?: string;
  VITE_OPENSOURCE_REPO_URL?: string;
}

/** Workers Cache caches fetch entrypoints, not custom RPC methods. */
export class DocsHostCache extends WorkerEntrypoint<
  DispatcherEnv,
  { hostname: string }
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
    const {
      hostname,
      rendererBuildId,
      resolution,
      lifetime,
      deliveryRenderId,
    } = this.ctx.props;
    if (
      !isCacheableDocsRequest(request) ||
      !isPublicProduction(resolution) ||
      hostname !== new URL(request.url).hostname ||
      resolution.hostname !== hostname ||
      rendererBuildId !== this.env.DOXA_RENDERER_BUILD_ID ||
      !isContentCacheLifetime(lifetime) ||
      // The HTML embeds this ID, so the key must contain the same value.
      readInternalRenderId(request) !== deliveryRenderId
    ) {
      return withoutResponseCaching(
        new Response("Invalid cache request", { status: 400 }),
      );
    }
    const timing = createServerTiming(this.env.DEBUG);
    const rendered = await renderWithDynamicWorker(
      request,
      resolution,
      this.env,
      this.ctx,
      timing,
    );
    return attachInternalServerTiming(
      withHtmlCachePolicy(rendered, lifetime),
      timing,
    );
  }
}

/** Narrow private RPC facade over the approved immutable renderer package. */
export class PrerenderRendererApi extends WorkerEntrypoint<DispatcherEnv> {
  async getPlan(input: { resolution: DocsHostResolution }): Promise<unknown> {
    const result = await this.env.DOCS_RUNTIME.request({
      resolution: input.resolution,
      operation: "getPrerenderPlan",
    });
    if (!result.ok)
      throw new Error("The docs runtime could not build a pre-render plan.");
    return result.data;
  }

  async prepare(input: {
    resolution: DocsHostResolution;
    pathname: string;
  }): Promise<PublicDocsRouteDataV1> {
    const timing = createServerTiming(this.env.DEBUG);
    const renderer = await getPrivatePrerenderRenderer(
      input.resolution,
      this.env,
      this.ctx,
      timing,
    );
    return parsePublicDocsRouteDataV1(
      await renderer.prepare({ pathname: input.pathname }),
    );
  }

  async render(input: {
    resolution: DocsHostResolution;
    pathname: string;
    requestUrl: string;
    renderId: string;
    routeData: PublicDocsRouteDataV1;
  }): Promise<Response> {
    const timing = createServerTiming(this.env.DEBUG);
    const renderer = await getPrivatePrerenderRenderer(
      input.resolution,
      this.env,
      this.ctx,
      timing,
    );
    return renderer.render({
      pathname: input.pathname,
      requestUrl: input.requestUrl,
      renderId: input.renderId,
      routeData: parsePublicDocsRouteDataV1(input.routeData),
    });
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
    return this.env.DOCS_RUNTIME.request({
      resolution: this.ctx.props.resolution,
      operation: input.operation,
      ...(input.payload === undefined ? {} : { payload: input.payload }),
    });
  }
}

export default {
  async fetch(
    request: Request,
    env: DispatcherEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const timing = createServerTiming(env.DEBUG);
    const mode = parseRendererMode(env.DOXA_PROD_DYNAMIC_RENDERER_MODE);
    const allowedSiteIds = parseSiteAllowlist(
      env.DOXA_PROD_DYNAMIC_RENDERER_SITE_IDS,
    );
    const rollouts = readDeliveryRollouts(env);

    const cacheable = isCacheableDocsRequest(request);
    const prerenderable = isPrerenderableDocsRequest(request);
    const isRouteDataEndpoint =
      new URL(request.url).pathname === ROUTE_DATA_PATH;
    let hostCacheStatus = "BYPASS";
    let htmlCacheStatus = "BYPASS";
    let usedHtmlCache = false;
    let prerenderFallback = false;
    let prerenderDiagnostics: PrerenderAttemptDiagnostics | null = null;
    let resolvedHost: DocsDomainResolution | null | undefined;
    const resolveHost = (hostname: string) =>
      timing.measure(
        "doxa_resolve",
        async () => {
          if (resolvedHost !== undefined) return resolvedHost;
          // The resolution depends only on the hostname, and the entrypoint
          // stores public production mappings only. Visitor-specific requests
          // can share it; they still bypass the HTML cache.
          const cached = await getWorkerExports(ctx)
            .DocsHostCache({ props: { hostname } })
            .fetch("https://docs-cache.internal/resolve");
          hostCacheStatus =
            cached.headers.get("cf-cache-status") ?? "UNAVAILABLE";
          if (!cached.ok) throw new Error("Hostname cache lookup failed");
          resolvedHost = docsDomainResolutionSchema
            .nullable()
            .parse(await cached.json());
          return resolvedHost;
        },
        () => hostCacheStatus,
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
        withDocsSecurityHeaders(withoutResponseCaching(routeData.response)),
        resolvedHost,
      );
      result.headers.set("x-doxa-host-cache", hostCacheStatus);
      result.headers.set("x-doxa-route-data-cache", routeData.cacheStatus);
      exposeRequestTiming(result, result, timing, {
        usedHtmlCache: false,
        htmlCacheStatus: "BYPASS",
      });
      logRequestTiming(request, result, timing, {
        hostCacheStatus,
        htmlCacheStatus: "BYPASS",
        routeDataCacheStatus: routeData.cacheStatus,
      });
      return result;
    }

    if (prerenderable && rollouts.prerender.mode !== "off") {
      const saved = await tryPrerenderedHtml(deliveryContext);
      prerenderDiagnostics = saved.diagnostics;
      if (saved.response) {
        const result = withDocsPreviewSearchPolicy(
          withDocsSecurityHeaders(withoutResponseCaching(saved.response)),
          resolvedHost,
        );
        result.headers.set("x-doxa-host-cache", hostCacheStatus);
        result.headers.set("x-doxa-html-cache", "PRERENDER");
        if (prerenderDiagnostics) {
          applyPrerenderDiagnostics(result, prerenderDiagnostics, timing);
        }
        exposeRequestTiming(result, saved.response, timing, {
          usedHtmlCache: false,
          htmlCacheStatus: "PRERENDER",
        });
        logRequestTiming(request, result, timing, {
          hostCacheStatus,
          htmlCacheStatus: "PRERENDER",
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
          const props = createHtmlCacheProps(pinnedRequest, resolution, {
            rendererBuildId: requireEnvValue(
              env.DOXA_RENDERER_BUILD_ID,
              "DOXA_RENDERER_BUILD_ID",
            ),
            deliveryRenderId: deliveryRenderId ?? null,
            lifetime: prerenderFallback ? "liveFallback" : "versioned",
          });
          // Canonical public HTML must not vary with unkeyed visitor headers.
          const canonicalRequest = new Request(pinnedRequest.url, {
            method: pinnedRequest.method,
            headers: compactHeaders({
              accept: "text/html",
              [INTERNAL_RENDER_ID_HEADER]: deliveryRenderId,
            }),
          });
          return timing.measure(
            "doxa_html",
            async () => {
              const cached = await getWorkerExports(ctx)
                .DocsHtmlCache({ props })
                .fetch(canonicalRequest);
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
      withDocsSecurityHeaders(withoutResponseCaching(response)),
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
    result.headers.set("x-doxa-host-cache", hostCacheStatus);
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
    });
    return result;
  },
} satisfies ExportedHandler<DispatcherEnv>;

const INTERNAL_RENDER_ID_HEADER = "x-doxa-internal-render-id";

function withInternalRenderId(request: Request, renderId?: string): Request {
  const headers = new Headers(request.headers);
  headers.delete(INTERNAL_RENDER_ID_HEADER);
  if (renderId) headers.set(INTERNAL_RENDER_ID_HEADER, renderId);
  return new Request(request, { headers });
}

function readInternalRenderId(request: Request): string | null {
  return request.headers.get(INTERNAL_RENDER_ID_HEADER);
}

function compactHeaders(value: Record<string, string | undefined>): Headers {
  const headers = new Headers();
  for (const [name, item] of Object.entries(value)) {
    if (item !== undefined) headers.set(name, item);
  }
  return headers;
}

async function renderWithDynamicWorker(
  request: Request,
  resolution: DocsDomainResolution,
  env: DispatcherEnv,
  ctx: ExecutionContext,
  timing: ServerTimingRecorder,
): Promise<Response> {
  const rendererBuildId = requireEnvValue(
    env.DOXA_RENDERER_BUILD_ID,
    "DOXA_RENDERER_BUILD_ID",
  );
  const objectKey = requireEnvValue(
    env.DOXA_RENDERER_PACKAGE_KEY,
    "DOXA_RENDERER_PACKAGE_KEY",
  );
  const workerId = createDynamicWorkerId({
    siteId: resolution.siteId,
    publishedVersionId: resolution.publishedVersionId,
    rendererBuildId,
  });
  const hostResolution = toHostResolution(resolution);
  const contentBinding = getWorkerExports(ctx).ScopedDocsContent({
    props: { resolution: hostResolution },
  });

  let loadedRendererCode = false;
  return timing.measure(
    "doxa_loader",
    async () => {
      const worker = env.LOADER.get(workerId, async () => {
        loadedRendererCode = true;
        const code = await timing.measure("doxa_code", () =>
          loadRendererCodePackage({
            bucket: env.RENDERER_CODE_BUCKET,
            objectKey,
            expectedBuildId: rendererBuildId,
          }),
        );

        return {
          compatibilityDate: code.compatibilityDate,
          compatibilityFlags: code.compatibilityFlags,
          mainModule: code.mainModule,
          modules: code.modules,
          env: compactEnv({
            DOXA_DOCS_RUNTIME_SOURCE: "binding",
            DOXA_DOCS_CONTENT_BINDING: contentBinding,
            DOXA_DOCS_CONTENT_RESOLUTION: hostResolution,
            DOXA_API_BASE_URL: env.DOXA_API_BASE_URL,
            DOXA_DASHBOARD_BASE_URL: env.DOXA_DASHBOARD_BASE_URL,
            DOXA_DOCS_BASE_DOMAIN: env.DOXA_DOCS_BASE_DOMAIN,
            VITE_OPENSOURCE_REPO_URL: env.VITE_OPENSOURCE_REPO_URL,
          }),
          globalOutbound: null,
          limits: {
            cpuMs: 30_000,
            subRequests: 50,
          },
        };
      });

      return timing.measure(
        "doxa_render",
        () => worker.getEntrypoint().fetch(request),
        "DYNAMIC",
      );
    },
    () => (loadedRendererCode ? "COLD" : "WARM"),
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

async function getPrivatePrerenderRenderer(
  resolution: DocsHostResolution,
  env: DispatcherEnv,
  ctx: ExecutionContext,
  timing: ServerTimingRecorder,
): Promise<PrivatePrerenderRenderer> {
  const rendererBuildId = requireEnvValue(
    env.DOXA_RENDERER_BUILD_ID,
    "DOXA_RENDERER_BUILD_ID",
  );
  const objectKey = requireEnvValue(
    env.DOXA_RENDERER_PACKAGE_KEY,
    "DOXA_RENDERER_PACKAGE_KEY",
  );
  const workerId = createDynamicWorkerId({
    siteId: resolution.siteId,
    publishedVersionId: resolution.publishedVersionId,
    rendererBuildId,
  });
  const contentBinding = getWorkerExports(ctx).ScopedDocsContent({
    props: { resolution },
  });
  const worker = env.LOADER.get(workerId, async () => {
    const code = await timing.measure("doxa_code", () =>
      loadRendererCodePackage({
        bucket: env.RENDERER_CODE_BUCKET,
        objectKey,
        expectedBuildId: rendererBuildId,
      }),
    );
    return {
      compatibilityDate: code.compatibilityDate,
      compatibilityFlags: code.compatibilityFlags,
      mainModule: code.mainModule,
      modules: code.modules,
      env: compactEnv({
        DOXA_DOCS_RUNTIME_SOURCE: "binding",
        DOXA_DOCS_CONTENT_BINDING: contentBinding,
        DOXA_DOCS_CONTENT_RESOLUTION: resolution,
        DOXA_API_BASE_URL: env.DOXA_API_BASE_URL,
        DOXA_DASHBOARD_BASE_URL: env.DOXA_DASHBOARD_BASE_URL,
        DOXA_DOCS_BASE_DOMAIN: env.DOXA_DOCS_BASE_DOMAIN,
        VITE_OPENSOURCE_REPO_URL: env.VITE_OPENSOURCE_REPO_URL,
      }),
      globalOutbound: null,
      limits: { cpuMs: 30_000, subRequests: 50 },
    };
  });
  const entrypoint: unknown = worker.getEntrypoint("DocsPrerenderRenderer");
  if (!isPrivatePrerenderRenderer(entrypoint)) {
    throw new Error(
      "The renderer package has no private pre-render entrypoint.",
    );
  }
  return entrypoint;
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

function requireEnvValue(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (normalized) return normalized;
  throw new Error(`Missing required dispatcher variable: ${name}.`);
}

function compactEnv(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}
