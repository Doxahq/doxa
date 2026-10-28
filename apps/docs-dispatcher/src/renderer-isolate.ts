import type { DocsHostResolution } from "@doxahq/contracts";

import { requireEnvValue } from "./env-values";
import { loadRendererCodePackage } from "./renderer-code-package";
import {
  isSiteInRollout,
  parseRolloutMode,
  parseSiteAllowlist,
  type SiteRollout,
} from "./rollout-policy";
import {
  createDynamicWorkerId,
  createSharedRendererWorkerId,
} from "./routing-policy";
import type { ServerTimingRecorder } from "./server-timing";
import type { DocsRuntimeRpc } from "./worker-exports";

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
}

export type RendererEntrypointName = "fetch" | "prepare" | "render";

/** How one renderer call ended: a fetch response, an RPC result, or a throw. */
export type RendererCallOutcome =
  | { ok: boolean; status: number }
  | { ok: true }
  | { ok: false; error: string };

const RENDERER_LIMITS = { cpuMs: 30_000, subRequests: 50 } as const;

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

export function selectRendererIsolateScope(
  rollout: SiteRollout,
  siteId: string,
): RendererIsolateScope {
  return isSiteInRollout(rollout, siteId) ? "build" : "site";
}

/**
 * Gets the renderer isolate for one request. `content` must be the
 * `ScopedDocsContent` binding pinned to `resolution`.
 */
export function openRendererIsolate(input: {
  env: RendererIsolateEnv;
  resolution: DocsHostResolution;
  content: DocsRuntimeRpc;
  timing: ServerTimingRecorder;
}): RendererIsolate {
  const { env, resolution, content, timing } = input;
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

  const load: { cold: boolean; codeLoadMs?: number } = { cold: false };
  const worker = env.LOADER.get(workerId, async () => {
    load.cold = true;
    const startedAt = Date.now();
    const code = await timing.measure("doxa_code", () =>
      loadRendererCodePackage({
        bucket: env.RENDERER_CODE_BUCKET,
        objectKey,
        expectedBuildId: rendererBuildId,
      }),
    );
    load.codeLoadMs = Date.now() - startedAt;
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
 */
export function logRendererUse(
  isolate: RendererIsolate,
  input: {
    entrypoint: RendererEntrypointName;
    resolution: Pick<DocsHostResolution, "siteId" | "publishedVersionId">;
    startedAt: number;
    outcome: RendererCallOutcome;
  },
): void {
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
      totalMs: Date.now() - input.startedAt,
      ...input.outcome,
    }),
  );
}
