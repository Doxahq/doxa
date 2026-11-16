import type { DocsHostResolution } from "@doxahq/contracts";

import { requireEnvValue } from "./env-values";
import {
  loadRendererCodePackage,
  type RendererCodeSource,
} from "./renderer-code-package";
import {
  createRendererCodeReaders,
  type RendererCodeCacheProps,
} from "./renderer-code-readers";
import type {
  BodyTiming,
  RendererIsolateFacts,
  RenderPhases,
} from "./renderer-timing";
import {
  isSiteInRollout,
  parseRolloutMode,
  parseSiteAllowlist,
  type SiteRollout,
} from "./rollout-policy";
import type { RouteDataPrefetchReport } from "./route-data-prefetch";
import {
  createDynamicWorkerId,
  createSharedRendererWorkerId,
} from "./routing-policy";
import type { ServerTimingRecorder } from "./server-timing";
import type { CacheEntrypoint, DocsRuntimeRpc } from "./worker-exports";

/**
 * Which Dynamic Worker isolate renders a site.
 *
 * - `site`: one isolate per site, version and renderer build. The content
 *   binding is fixed in the isolate's env when the isolate starts.
 * - `build`: one isolate per renderer build, shared by every site in the
 *   shared-isolate rollout. Each request passes its content binding as
 *   entrypoint props, and the binding works only during that request.
 */
export type RendererIsolateScope = "site" | "build";

export interface RendererIsolateEnv {
  LOADER: WorkerLoader;
  RENDERER_CODE_BUCKET: R2Bucket;
  DOXA_RENDERER_BUILD_ID?: string;
  DOXA_RENDERER_PACKAGE_KEY?: string;
  DOXA_PROD_SHARED_ISOLATE_MODE?: string;
  DOXA_PROD_SHARED_ISOLATE_SITE_IDS?: string;
  DOXA_API_BASE_URL?: string;
  DOXA_DASHBOARD_BASE_URL?: string;
  DOXA_DOCS_BASE_DOMAIN?: string;
  VITE_OPENSOURCE_REPO_URL?: string;
}

/**
 * Entrypoint props of every renderer call in the `build` scope. The renderer
 * reads them with `readRendererRequestScope` in docs-template.
 */
export interface RendererRequestProps {
  content: DocsRuntimeRpc;
  resolution: DocsHostResolution;
}

/** A renderer for one request, and what its isolate cost this request. */
export interface RendererIsolate {
  readonly scope: RendererIsolateScope;
  readonly rendererBuildId: string;
  /** In the `build` scope, the entrypoint carries this request's props. */
  getEntrypoint(name?: string): Fetcher;
  /** True when this request started the isolate and loaded the code. */
  readonly cold: boolean;
  readonly codeLoadMs: number | undefined;
  /** Where the cold start got its code. Undefined for a warm isolate. */
  readonly codeSource: RendererCodeSource | undefined;
}

export type RendererEntrypointName = "fetch" | "prepare" | "render";

/** How one renderer call ended: a fetch response, an RPC result, or a throw. */
export type RendererCallOutcome =
  | { ok: boolean; status: number }
  | { ok: true }
  | { ok: false; error: string };

/**
 * Limits of one renderer call. In the `build` scope every site shares the
 * isolate (M46), so one call must not hold its CPU for long. The slowest
 * cold render seen in production (29 Oct tail) took 2.4 s of wall time,
 * which bounds its CPU time, so 5 s leaves headroom.
 *
 * Every content read through the props binding counts as a subrequest.
 * `/llms.txt` and `/llms-full.txt` read every page of a site, plus its
 * sections, routes and config, so the limit must cover the largest page plan
 * (2,000 routes). At 50, every site with 50 or more pages lost its llms
 * routes to the shared fallback (29 Oct production test).
 */
const RENDERER_LIMITS = { cpuMs: 5_000, subRequests: 3_000 } as const;

/**
 * The code a renderer returns (in `x-doxa-renderer-error`) or throws (in the
 * message) when a call reached it without its request-scope props.
 */
export const RENDERER_PROPS_MISSING_CODE = "renderer_props_missing";
const RENDERER_ERROR_HEADER = "x-doxa-renderer-error";

/**
 * True when a renderer response, error or error message says the call had
 * no request-scope props.
 */
export function isRendererPropsMissing(outcome: unknown): boolean {
  if (outcome instanceof Response) {
    return (
      outcome.headers.get(RENDERER_ERROR_HEADER) === RENDERER_PROPS_MISSING_CODE
    );
  }
  const message = outcome instanceof Error ? outcome.message : outcome;
  return (
    typeof message === "string" &&
    message.includes(`[${RENDERER_PROPS_MISSING_CODE}]`)
  );
}

/**
 * Logs a renderer call that had no request scope. It happens only when the
 * dispatcher fails to send the props, so it is its own event, apart from
 * the fallback to the shared renderer that may follow.
 */
export function logRendererPropsMissing(input: {
  entrypoint: RendererEntrypointName;
  resolution: Pick<DocsHostResolution, "siteId" | "publishedVersionId">;
  fallback: boolean;
}): void {
  console.error(
    JSON.stringify({
      event: RENDERER_PROPS_MISSING_CODE,
      entrypoint: input.entrypoint,
      siteId: input.resolution.siteId,
      publishedVersionId: input.resolution.publishedVersionId,
      fallback: input.fallback,
    }),
  );
}

export function readSharedIsolateRollout(
  env: Pick<
    RendererIsolateEnv,
    "DOXA_PROD_SHARED_ISOLATE_MODE" | "DOXA_PROD_SHARED_ISOLATE_SITE_IDS"
  >,
  warn: (message: string) => void = console.warn,
): SiteRollout {
  return {
    mode: parseRolloutMode(env.DOXA_PROD_SHARED_ISOLATE_MODE, (invalid) =>
      warn(
        `[doxa-docs-dispatcher] Invalid DOXA_PROD_SHARED_ISOLATE_MODE ${JSON.stringify(invalid)}; every site keeps its own renderer isolate.`,
      ),
    ),
    siteIds: parseSiteAllowlist(env.DOXA_PROD_SHARED_ISOLATE_SITE_IDS),
  };
}

/**
 * Billing spec 9.4: the API adds the hosting tier of the site's plan to the
 * resolution only with billing enforcement `on`. A `shared` site renders in
 * the shared build isolate, a `dedicated` site in its own isolate, and the
 * operator list no longer decides. A resolution without a tier (enforcement
 * `off` or `shadow`, where the API only logs the tier, or an entry written
 * before billing) keeps the operator list exactly.
 */
export function selectRendererIsolateScope(
  rollout: SiteRollout,
  siteId: string,
  hostingTier?: DocsHostResolution["hostingTier"],
): RendererIsolateScope {
  if (hostingTier === "shared") return "build";
  if (hostingTier === "dedicated") return "site";
  return isSiteInRollout(rollout, siteId) ? "build" : "site";
}

/**
 * Gets the renderer isolate for one request. `content` must be the
 * `ScopedDocsContent` binding pinned to `resolution`. `codeCache` is the
 * dispatcher's own `DocsRendererCodeCache` entrypoint. `onColdStart` runs
 * when this request starts the isolate, before its code loads.
 */
export function openRendererIsolate(input: {
  env: RendererIsolateEnv;
  resolution: DocsHostResolution;
  content: DocsRuntimeRpc;
  codeCache: CacheEntrypoint<RendererCodeCacheProps>;
  timing: ServerTimingRecorder;
  onColdStart?: () => void;
}): RendererIsolate {
  const { env, resolution, content, codeCache, timing, onColdStart } = input;
  const rendererBuildId = requireEnvValue(
    env.DOXA_RENDERER_BUILD_ID,
    "DOXA_RENDERER_BUILD_ID",
  );
  const objectKey = requireEnvValue(
    env.DOXA_RENDERER_PACKAGE_KEY,
    "DOXA_RENDERER_PACKAGE_KEY",
  );
  const scope = selectRendererIsolateScope(
    readSharedIsolateRollout(env),
    resolution.siteId,
    resolution.hostingTier,
  );
  const workerId =
    scope === "build"
      ? createSharedRendererWorkerId(rendererBuildId)
      : createDynamicWorkerId({
          siteId: resolution.siteId,
          publishedVersionId: resolution.publishedVersionId,
          rendererBuildId,
        });
  const siteContent: RendererRequestProps = { content, resolution };

  const load: {
    cold: boolean;
    codeLoadMs?: number;
    codeSource?: RendererCodeSource;
  } = { cold: false };
  const worker = env.LOADER.get(workerId, async () => {
    load.cold = true;
    onColdStart?.();
    const startedAt = Date.now();
    const { code, source } = await timing.measure("doxa_code", () =>
      loadRendererCodePackage({
        objectKey,
        expectedBuildId: rendererBuildId,
        readers: createRendererCodeReaders({
          cache: codeCache,
          bucket: env.RENDERER_CODE_BUCKET,
          buildId: rendererBuildId,
          objectKey,
        }),
        warn: (message) => console.warn(message),
      }),
    );
    load.codeLoadMs = Date.now() - startedAt;
    load.codeSource = source;
    return {
      compatibilityDate: code.compatibilityDate,
      compatibilityFlags: code.compatibilityFlags,
      mainModule: code.mainModule,
      modules: code.modules,
      env: createIsolateEnv(env, scope === "site" ? siteContent : undefined),
      globalOutbound: null,
      limits: RENDERER_LIMITS,
    };
  });

  return {
    scope,
    rendererBuildId,
    getEntrypoint: (name) =>
      worker.getEntrypoint(
        name,
        scope === "build" ? { props: siteContent } : undefined,
      ),
    get cold() {
      return load.cold;
    },
    get codeLoadMs() {
      return load.codeLoadMs;
    },
    get codeSource() {
      return load.codeSource;
    },
  };
}

/**
 * The env that an isolate keeps for its whole life. A `build` isolate gets no
 * site content: the loader runs only on a cold start, and every later request
 * of every site reuses this env.
 */
function createIsolateEnv(
  env: RendererIsolateEnv,
  pinnedSite: RendererRequestProps | undefined,
): Record<string, unknown> {
  const isolateEnv: Record<string, unknown> = {
    DOXA_DOCS_RUNTIME_SOURCE: "binding",
    DOXA_API_BASE_URL: env.DOXA_API_BASE_URL,
    DOXA_DASHBOARD_BASE_URL: env.DOXA_DASHBOARD_BASE_URL,
    DOXA_DOCS_BASE_DOMAIN: env.DOXA_DOCS_BASE_DOMAIN,
    VITE_OPENSOURCE_REPO_URL: env.VITE_OPENSOURCE_REPO_URL,
  };
  if (pinnedSite) {
    isolateEnv.DOXA_DOCS_CONTENT_BINDING = pinnedSite.content;
    isolateEnv.DOXA_DOCS_CONTENT_RESOLUTION = pinnedSite.resolution;
  }
  return Object.fromEntries(
    Object.entries(isolateEnv).filter(([, value]) => value !== undefined),
  );
}

/**
 * Logs every renderer call that the dispatcher makes, with or without DEBUG.
 * Compare COLD and WARM by `isolateScope` to judge the shared-isolate rollout.
 * `phases` and `renderer` come from the renderer's own timing report, and
 * `bodyMs` measures the streamed body after the response arrived.
 */
export function logRendererUse(
  isolate: RendererIsolate,
  input: {
    entrypoint: RendererEntrypointName;
    resolution: Pick<DocsHostResolution, "siteId" | "publishedVersionId">;
    startedAt: number;
    /** When the call returned its response. Defaults to now. */
    finishedAt?: number;
    outcome: RendererCallOutcome;
    phases?: RenderPhases;
    renderer?: RendererIsolateFacts;
    body?: BodyTiming;
    routeDataPrefetch?: RouteDataPrefetchReport;
  },
): void {
  // The fetch path logs it in `dispatchDocsRequest`, before its fallback.
  if (
    input.entrypoint !== "fetch" &&
    "error" in input.outcome &&
    isRendererPropsMissing(input.outcome.error)
  ) {
    logRendererPropsMissing({
      entrypoint: input.entrypoint,
      resolution: input.resolution,
      fallback: false,
    });
  }
  console.info(
    JSON.stringify({
      event: "docs_renderer_load",
      entrypoint: input.entrypoint,
      siteId: input.resolution.siteId,
      publishedVersionId: input.resolution.publishedVersionId,
      isolateScope: isolate.scope,
      rendererBuildId: isolate.rendererBuildId,
      state: isolate.cold ? "COLD" : "WARM",
      ...(isolate.codeLoadMs !== undefined
        ? { codeLoadMs: isolate.codeLoadMs }
        : {}),
      ...(isolate.codeSource ? { codeSource: isolate.codeSource } : {}),
      totalMs: (input.finishedAt ?? Date.now()) - input.startedAt,
      ...input.outcome,
      ...(input.phases ? { phases: input.phases } : {}),
      ...(input.renderer ? { renderer: input.renderer } : {}),
      ...(input.routeDataPrefetch
        ? { routeDataPrefetch: input.routeDataPrefetch }
        : {}),
      ...(input.body ?? {}),
    }),
  );
}
