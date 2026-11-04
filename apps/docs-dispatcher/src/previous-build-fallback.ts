import type { DocsDomainResolution } from "@doxahq/contracts";
import type { WarmPool } from "@doxahq/contracts/docs-warm-state";

import { isPublicProduction } from "./cache-policy";
import {
  createBuildIdentity,
  createRouteDataCacheCall,
  createSavedOutputCall,
  fetchPublicCacheCall,
  selectPublicCacheCalls,
  type PublicCacheCall,
  type PublicCacheCallEnv,
} from "./public-cache-calls";
import type { PrerenderCacheProps } from "./prerender-cache-entrypoint";
import {
  readPreviousRendererBuild,
  readRendererDeployedAt,
  type RendererBuild,
  type RendererBuildEnv,
} from "./previous-renderer-build";
import {
  isSiteInRollout,
  parseRolloutMode,
  parseSiteAllowlist,
  type SiteRollout,
} from "./rollout-policy";
import { probeCache } from "./versioned-entrypoint-protocol";
import { poolForRequest } from "./warm-pool";
import {
  readPoolWarmState,
  type WarmStateStatus,
  type WarmStateStore,
} from "./warm-state";
import type { DispatcherExports } from "./worker-exports";

/**
 * M26: during the build window after a renderer deploy, a visitor whose
 * upper-tier pool is not warm yet gets the previous build's cached output
 * instead of waiting for a render. The dispatcher never probes a live key
 * (F38): "is the live key warm here?" comes from the warm-state record, and
 * only previous-build keys, which nobody fills, are probed. Nothing here fills
 * a cache; the warm job does. See docs/current/production-docs-caching.md,
 * "Previous-build fallback".
 *
 * - `off`: today's path.
 * - `shadow`: today's path, and a background probe logs `wouldServe`.
 * - `on`: a previous-build hit is served with `x-doxa-html-cache: PREVIOUS`.
 */
export type PreviousFallbackMode = "off" | "shadow" | "on";

export const DEFAULT_FALLBACK_WINDOW_SECONDS = 86_400;
/** A longer window would outlive the 7-day stale lifetime of the entries. */
const MAX_FALLBACK_WINDOW_SECONDS = 7 * 86_400;
/** Tolerated clock difference between the deploy machine and Cloudflare. */
const DEPLOYED_AT_SKEW_MS = 5 * 60_000;

export interface PreviousFallbackEnv
  extends RendererBuildEnv,
    PublicCacheCallEnv {
  DOXA_PROD_PREVIOUS_FALLBACK_MODE?: string;
  DOXA_PREVIOUS_FALLBACK_BUILD_WINDOW_SECONDS?: string;
  /** The warm rollout (WS5 uses the same flags). The fallback reads its state. */
  DOXA_PROD_WARM_MODE?: string;
  DOXA_PROD_WARM_SITE_IDS?: string;
  DOCS_HOSTNAME_MAP?: WarmStateStore;
}

export interface PreviousFallbackContext {
  env: PreviousFallbackEnv;
  ctx: ExecutionContext;
  exports: Pick<
    DispatcherExports,
    "DocsHtmlCache" | "DocsPrerenderCache" | "DocsRouteDataCache"
  >;
  now: number;
}

/** `docs_request_cache.fallback`: logged whenever the window check passed. */
export interface FallbackFacts {
  mode: Exclude<PreviousFallbackMode, "off">;
  used: boolean;
  pool: WarmPool;
  warmState: WarmStateStatus;
  probe?: "hit" | "miss";
  probeMs?: number;
}

export interface PreviousHtmlAttempt {
  response: Response | null;
  facts: FallbackFacts | null;
}

const NO_FALLBACK: PreviousHtmlAttempt = { response: null, facts: null };

export function parsePreviousFallbackMode(
  value: string | undefined,
  warn: (message: string) => void = console.warn,
): PreviousFallbackMode {
  if (value === "shadow" || value === "on") return value;
  if (value !== undefined && value !== "off") {
    warn(
      `[doxa-docs-dispatcher] Invalid DOXA_PROD_PREVIOUS_FALLBACK_MODE ${JSON.stringify(value)}; the previous-build fallback is off.`,
    );
  }
  return "off";
}

/** Unset means the default; an invalid value turns the fallback off. */
export function parseFallbackWindowSeconds(
  value: string | undefined,
  warn: (message: string) => void = console.warn,
): number | null {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_FALLBACK_WINDOW_SECONDS;
  }
  const seconds = Number(value);
  if (
    Number.isInteger(seconds) &&
    seconds > 0 &&
    seconds <= MAX_FALLBACK_WINDOW_SECONDS
  ) {
    return seconds;
  }
  warn(
    `[doxa-docs-dispatcher] Invalid DOXA_PREVIOUS_FALLBACK_BUILD_WINDOW_SECONDS ${JSON.stringify(value)}; the previous-build fallback is off.`,
  );
  return null;
}

export function readWarmRollout(
  env: PreviousFallbackEnv,
  warn: (message: string) => void = console.warn,
): SiteRollout {
  return {
    mode: parseRolloutMode(env.DOXA_PROD_WARM_MODE, (invalid) =>
      warn(
        `[doxa-docs-dispatcher] Invalid DOXA_PROD_WARM_MODE ${JSON.stringify(invalid)}; the warm rollout is off.`,
      ),
    ),
    siteIds: parseSiteAllowlist(env.DOXA_PROD_WARM_SITE_IDS),
  };
}

export interface FallbackWindow {
  mode: Exclude<PreviousFallbackMode, "off">;
  previous: RendererBuild;
}

/**
 * The checks that need no read: public production, a mode, a previous build,
 * inside the build window, and a site in the warm rollout. Null means
 * today's path.
 */
export function selectFallbackWindow(
  env: PreviousFallbackEnv,
  resolution: DocsDomainResolution,
  now: number,
): FallbackWindow | null {
  if (!isPublicProduction(resolution)) return null;
  const mode = parsePreviousFallbackMode(env.DOXA_PROD_PREVIOUS_FALLBACK_MODE);
  if (mode === "off") return null;
  const previous = readPreviousRendererBuild(env);
  const deployedAt = readRendererDeployedAt(env);
  const windowSeconds = parseFallbackWindowSeconds(
    env.DOXA_PREVIOUS_FALLBACK_BUILD_WINDOW_SECONDS,
  );
  if (!previous || deployedAt === null || windowSeconds === null) return null;
  if (
    now < deployedAt - DEPLOYED_AT_SKEW_MS ||
    now >= deployedAt + windowSeconds * 1000
  ) {
    return null;
  }
  if (!isSiteInRollout(readWarmRollout(env), resolution.siteId)) return null;
  return { mode, previous };
}

type HtmlFallbackDecision =
  | { kind: "none" }
  | { kind: "live"; facts: FallbackFacts }
  | { kind: "probe"; window: FallbackWindow; facts: FallbackFacts };

/** Steps 1 and 2 of the request flow: the window, the pool, the warm state. */
async function decideHtmlFallback(
  context: PreviousFallbackContext,
  resolution: DocsDomainResolution,
  cf: unknown,
): Promise<HtmlFallbackDecision> {
  const window = selectFallbackWindow(context.env, resolution, context.now);
  if (!window) return { kind: "none" };
  const pool = poolForRequest(cf);
  const releaseId = context.env.DOXA_RENDERER_RELEASE_ID?.trim();
  if (!pool || !releaseId) return { kind: "none" };
  const warmState = await readPoolWarmState({
    store: context.env.DOCS_HOSTNAME_MAP,
    siteId: resolution.siteId,
    releaseId,
    pool,
  });
  const facts: FallbackFacts = { mode: window.mode, used: false, pool, warmState };
  return warmState === "warm"
    ? { kind: "live", facts }
    : { kind: "probe", window, facts };
}

/**
 * Steps 1–4 for one HTML request: probe the previous build's key of this
 * page. Only a visitor GET qualifies. M36 sites call this after a real 404
 * from saved output (F16); other sites before the HTML cache call.
 */
export async function tryPreviousBuildHtml(
  context: PreviousFallbackContext,
  input: {
    request: Request;
    resolution: DocsDomainResolution;
    /** `request.cf` of the visitor request: it places the visitor's pool. */
    cf: unknown;
  },
): Promise<PreviousHtmlAttempt> {
  if (input.request.method !== "GET") return NO_FALLBACK;
  const decision = await decideHtmlFallback(
    context,
    input.resolution,
    input.cf,
  );
  if (decision.kind === "none") return NO_FALLBACK;
  if (decision.kind === "live") return { response: null, facts: decision.facts };

  const url = new URL(input.request.url);
  const calls = await selectPublicCacheCalls({
    hostname: url.hostname,
    origin: url.origin,
    pathname: url.pathname,
    resolution: input.resolution,
    env: context.env,
    build: decision.window.previous,
  });
  if (!calls) return { response: null, facts: decision.facts };
  const probe = () => timedProbe(context, calls.html);

  if (decision.window.mode === "shadow") {
    context.ctx.waitUntil(
      probe().then(async (result) => {
        await result.response?.body?.cancel();
        logShadowProbe("docs_request_cache_fallback", input.request, {
          ...decision.facts,
          probe: result.status,
          probeMs: result.probeMs,
        });
      }).catch(() => undefined),
    );
    return { response: null, facts: decision.facts };
  }

  const result = await probe();
  return {
    response: result.response,
    facts: {
      ...decision.facts,
      used: result.response !== null,
      probe: result.status,
      probeMs: result.probeMs,
    },
  };
}

export interface PreviousRouteDataInput {
  request: Request;
  resolution: DocsDomainResolution;
  /** Normalized with `normalizePublicDocsPathname`. */
  pathname: string;
  /** The render ID that the visitor's page embeds. */
  renderHint: string;
  /** Saved output (M36) or the live route-data cache. */
  source:
    | { kind: "saved"; featureMode: PrerenderCacheProps["featureMode"] }
    | { kind: "cachedLive" };
}

export interface PreviousRouteData {
  /** The identity of the previous build, for the envelope (F15). */
  renderId: string;
  response: Response;
}

/**
 * Step 5 (D8): a page of the previous build asks for route data with the
 * previous render ID. Inside the window, probe the previous key; a hit is
 * served with that identity, anything else stays a 409.
 */
export async function tryPreviousRouteData(
  context: PreviousFallbackContext,
  input: PreviousRouteDataInput,
): Promise<PreviousRouteData | null> {
  const window = selectFallbackWindow(
    context.env,
    input.resolution,
    context.now,
  );
  if (!window) return null;
  const origin = new URL(input.request.url).origin;
  const identity = await createBuildIdentity(
    input.resolution,
    window.previous.releaseId,
    origin,
  );
  if (!identity || identity.renderId !== input.renderHint) return null;
  const call: PublicCacheCall =
    input.source.kind === "saved"
      ? createSavedOutputCall({
          origin,
          pathname: input.pathname,
          resolution: input.resolution,
          identity,
          featureMode: input.source.featureMode,
          representation: "data",
        })
      : createRouteDataCacheCall({
          origin,
          pathname: input.pathname,
          resolution: input.resolution,
          identity,
        });
  const probe = () => timedProbe(context, call);

  if (window.mode === "shadow") {
    context.ctx.waitUntil(
      probe().then(async (result) => {
        await result.response?.body?.cancel();
        logShadowProbe("docs_route_data_previous", input.request, {
          mode: window.mode,
          page: input.pathname,
          probe: result.status,
          probeMs: result.probeMs,
        });
      }).catch(() => undefined),
    );
    return null;
  }

  const result = await probe();
  logRouteDataPrevious(input.request, {
    mode: window.mode,
    page: input.pathname,
    used: result.response !== null,
    probe: result.status,
    probeMs: result.probeMs,
  });
  return result.response
    ? { renderId: identity.renderId, response: result.response }
    : null;
}

interface TimedProbe {
  status: "hit" | "miss";
  response: Response | null;
  probeMs: number;
}

async function timedProbe(
  context: PreviousFallbackContext,
  call: PublicCacheCall,
): Promise<TimedProbe> {
  const startedAt = Date.now();
  const outcome = await probeCache(() =>
    fetchPublicCacheCall(context.exports, call, { probe: true }),
  );
  const probeMs = Date.now() - startedAt;
  return outcome.status === "hit"
    ? { status: "hit", response: outcome.response, probeMs }
    : { status: "miss", response: null, probeMs };
}

function logShadowProbe(
  event: string,
  request: Request,
  facts: Record<string, unknown> & { probe: "hit" | "miss" },
): void {
  const url = new URL(request.url);
  console.info(
    JSON.stringify({
      event,
      hostname: url.hostname,
      path: url.pathname,
      ...facts,
      wouldServe: facts.probe === "hit",
    }),
  );
}

function logRouteDataPrevious(
  request: Request,
  facts: Record<string, unknown>,
): void {
  const url = new URL(request.url);
  console.info(
    JSON.stringify({
      event: "docs_route_data_previous",
      hostname: url.hostname,
      ...facts,
    }),
  );
}
