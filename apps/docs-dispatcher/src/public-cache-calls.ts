import { withoutSearchTarget } from "@doxahq/contracts/docs-search";
import type { DocsDomainResolution } from "@doxahq/contracts";
import {
  normalizePublicDocsPathname,
  type PrerenderIdentity,
} from "@doxahq/contracts/docs-prerender";

import {
  createHtmlCacheProps,
  isPublicProduction,
  type ContentCacheLifetime,
  type HtmlCacheProps,
} from "./cache-policy";
import {
  getEnabledPrerenderMode,
  readDeliveryRollouts,
  selectRouteDataDelivery,
  type DeliveryRolloutEnv,
  type RouteDataDelivery,
} from "./delivery-identity";
import type { PrerenderCacheProps } from "./prerender-cache-entrypoint";
import { createExpectedPrerenderIdentity } from "./prerender-policy";
import {
  readCurrentRendererBuild,
  type RendererBuild,
} from "./previous-renderer-build";
import {
  createRouteDataCacheUrl,
  type RouteDataCacheProps,
} from "./route-data-cache-entrypoint";
import { withCacheProbe } from "./versioned-entrypoint-protocol";
import type { DispatcherExports } from "./worker-exports";

/**
 * One place that builds the exact cache calls (entrypoint, props, canonical
 * request) of a public page: the visitor path, the previous-build fallback
 * and the warm job use it, so all three read and fill the same keys. A change
 * here changes cache keys; the golden test in
 * tests/public-cache-calls.test.ts must change with it (F17).
 */

/** Set by the dispatcher only; the HTML embeds it, so the key carries it too. */
export const INTERNAL_RENDER_ID_HEADER = "x-doxa-internal-render-id";

export type HtmlCacheCall = {
  entrypoint: "DocsHtmlCache";
  props: HtmlCacheProps;
  request: Request;
};

export type SavedOutputCacheCall = {
  entrypoint: "DocsPrerenderCache";
  props: PrerenderCacheProps;
  request: Request;
};

export type RouteDataCacheCall = {
  entrypoint: "DocsRouteDataCache";
  props: RouteDataCacheProps;
  request: Request;
};

export type PublicCacheCall =
  | HtmlCacheCall
  | SavedOutputCacheCall
  | RouteDataCacheCall;

export interface PublicCacheCalls {
  delivery: RouteDataDelivery | null;
  /** The version identity the HTML embeds; null when no delivery is active. */
  identity: PrerenderIdentity | null;
  /** M36 sites: saved HTML. Other sites: the versioned HTML cache. */
  html: HtmlCacheCall | SavedOutputCacheCall;
  /** Route data for client navigation; null when no delivery is active. */
  data: SavedOutputCacheCall | RouteDataCacheCall | null;
}

export interface PublicCacheCallEnv extends DeliveryRolloutEnv {
  DOXA_RENDERER_BUILD_ID?: string;
  DOXA_RENDERER_RELEASE_ID?: string;
  DOCS_RENDERED_BUCKET?: R2Bucket;
}

/**
 * Required inputs, none of them visitor-controlled:
 * - `hostname`: the public hostname; must equal `resolution.hostname`.
 * - `origin`: `https://{hostname}`.
 * - `pathname`: the page path as it appears in a request URL (encoded, no
 *   query).
 * - `resolution`: the trusted public production resolution of `hostname`.
 * - `env`: the dispatcher rollouts, the deployed build and the
 *   `DOCS_RENDERED_BUCKET` binding.
 * - `build`: the renderer build to address; the deployed one by default. The
 *   previous-build fallback passes the previous build.
 * - `method`: the HTML method; `HEAD` only for a visitor HEAD.
 */
export interface PublicCacheCallInput {
  hostname: string;
  origin: string;
  pathname: string;
  resolution: DocsDomainResolution;
  env: PublicCacheCallEnv;
  build?: RendererBuild;
  method?: "GET" | "HEAD";
}

const RELEASE_ID_PATTERN = /^[a-f0-9]{64}$/;

/** Null when the inputs do not describe a cacheable public production page. */
export async function selectPublicCacheCalls(
  input: PublicCacheCallInput,
): Promise<PublicCacheCalls | null> {
  const { hostname, origin, pathname, resolution, env } = input;
  const build = input.build ?? readCurrentRendererBuild(env);
  if (
    !build ||
    !isPublicProduction(resolution) ||
    resolution.hostname !== hostname ||
    !isHttpsOriginOf(origin, hostname)
  ) {
    return null;
  }
  const rollouts = readDeliveryRollouts(env);
  const delivery = selectRouteDataDelivery(rollouts, resolution.siteId);
  const identity = delivery
    ? await createBuildIdentity(resolution, build.releaseId, origin)
    : null;
  const active = identity ? delivery : null;
  const featureMode = getEnabledPrerenderMode(rollouts);
  const normalizedPathname = normalizeOrNull(pathname);

  if (
    active === "saved" &&
    identity &&
    featureMode &&
    env.DOCS_RENDERED_BUCKET &&
    normalizedPathname
  ) {
    const saved = { origin, resolution, identity, featureMode };
    return {
      delivery: active,
      identity,
      html: createSavedOutputCall({
        ...saved,
        pathname: normalizedPathname,
        representation: "html",
        requestUrl: `${origin}${pathname}`,
      }),
      data: createSavedOutputCall({
        ...saved,
        pathname: normalizedPathname,
        representation: "data",
      }),
    };
  }

  const html = createHtmlCacheCall({
    url: `${origin}${pathname}`,
    method: input.method ?? "GET",
    resolution,
    rendererBuildId: build.buildId,
    deliveryRenderId: identity?.renderId ?? null,
    lifetime: "versioned",
  });
  const data =
    active === "cachedLive" && identity && normalizedPathname
      ? createRouteDataCacheCall({
          origin,
          pathname: normalizedPathname,
          resolution,
          identity,
        })
      : null;
  return { delivery: active, identity, html, data };
}

/** The HTML cache call of one page. `url` has no query. */
export function createHtmlCacheCall(input: {
  url: string;
  method: "GET" | "HEAD";
  resolution: DocsDomainResolution;
  rendererBuildId: string;
  deliveryRenderId: string | null;
  lifetime: ContentCacheLifetime;
}): HtmlCacheCall {
  // Canonical public HTML must not vary with unkeyed visitor headers.
  const headers = new Headers({ accept: "text/html" });
  if (input.deliveryRenderId) {
    headers.set(INTERNAL_RENDER_ID_HEADER, input.deliveryRenderId);
  }
  const request = new Request(input.url, { method: input.method, headers });
  return {
    entrypoint: "DocsHtmlCache",
    props: createHtmlCacheProps(request, input.resolution, {
      rendererBuildId: input.rendererBuildId,
      deliveryRenderId: input.deliveryRenderId,
      lifetime: input.lifetime,
    }),
    request,
  };
}

/**
 * The saved-output call of one page. HTML uses the page URL; route data keeps
 * its own internal URL space, so two representations never share a key.
 */
export function createSavedOutputCall(input: {
  origin: string;
  /** Normalized with `normalizePublicDocsPathname`. */
  pathname: string;
  resolution: DocsDomainResolution;
  identity: PrerenderIdentity;
  featureMode: PrerenderCacheProps["featureMode"];
  representation: PrerenderCacheProps["representation"];
  /** HTML only: the page URL as requested. Defaults to origin + pathname. */
  requestUrl?: string;
}): SavedOutputCacheCall {
  const props: PrerenderCacheProps = {
    expected: input.identity,
    featureMode: input.featureMode,
    hostname: new URL(input.origin).hostname,
    pathname: input.pathname,
    representation: input.representation,
    resolution: withoutSearchTarget(input.resolution),
  };
  const request =
    input.representation === "html"
      ? new Request(input.requestUrl ?? `${input.origin}${input.pathname}`, {
          method: "GET",
          headers: { accept: "text/html" },
        })
      : createRouteDataRequest(input.origin, input.pathname);
  return { entrypoint: "DocsPrerenderCache", props, request };
}

/** The live route-data cache call of one page. */
export function createRouteDataCacheCall(input: {
  origin: string;
  /** Normalized with `normalizePublicDocsPathname`. */
  pathname: string;
  resolution: DocsDomainResolution;
  identity: PrerenderIdentity;
}): RouteDataCacheCall {
  return {
    entrypoint: "DocsRouteDataCache",
    props: {
      expected: input.identity,
      hostname: new URL(input.origin).hostname,
      pathname: input.pathname,
      resolution: withoutSearchTarget(input.resolution),
    },
    request: createRouteDataRequest(input.origin, input.pathname),
  };
}

/** Sends one cache call, as a probe when asked. */
export function fetchPublicCacheCall(
  exports: Pick<
    DispatcherExports,
    "DocsHtmlCache" | "DocsPrerenderCache" | "DocsRouteDataCache"
  >,
  call: PublicCacheCall,
  options: { probe?: boolean } = {},
): Promise<Response> {
  const request = options.probe ? withCacheProbe(call.request) : call.request;
  switch (call.entrypoint) {
    case "DocsHtmlCache":
      return exports.DocsHtmlCache({ props: call.props }).fetch(request);
    case "DocsPrerenderCache":
      return exports.DocsPrerenderCache({ props: call.props }).fetch(request);
    case "DocsRouteDataCache":
      return exports.DocsRouteDataCache({ props: call.props }).fetch(request);
  }
}

function createRouteDataRequest(origin: string, pathname: string): Request {
  return new Request(createRouteDataCacheUrl(origin, pathname), {
    method: "GET",
    headers: { accept: "application/json" },
  });
}

/**
 * The version identity of one renderer release, as `createDeliveryIdentity`
 * builds it for the deployed release. Null for a malformed release ID.
 */
export async function createBuildIdentity(
  resolution: DocsDomainResolution,
  releaseId: string,
  origin: string,
): Promise<PrerenderIdentity | null> {
  if (!RELEASE_ID_PATTERN.test(releaseId)) return null;
  return createExpectedPrerenderIdentity({
    siteId: resolution.siteId,
    artifactPrefix: resolution.artifactPrefix,
    manifestPath: resolution.manifestPath,
    rendererReleaseId: releaseId,
    trustedRequestOrigin: origin,
  });
}

function isHttpsOriginOf(origin: string, hostname: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "https:" &&
      url.origin === origin &&
      url.hostname === hostname
    );
  } catch {
    return false;
  }
}

function normalizeOrNull(pathname: string): string | null {
  try {
    return normalizePublicDocsPathname(pathname);
  } catch {
    return null;
  }
}
