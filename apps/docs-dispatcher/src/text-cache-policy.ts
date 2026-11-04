import type { DocsDomainResolution } from "@doxahq/contracts";

import {
  cacheControlFor,
  isPublicProduction,
  isRendererApiRoute,
  withoutResponseCaching,
} from "./cache-policy";
import {
  isSiteInRollout,
  parseRolloutMode,
  parseSiteAllowlist,
  type SiteRollout,
} from "./rollout-policy";

/**
 * Text routes of a docs site: `/llms.txt`, `/llms-full.txt`, `/sitemap.xml`,
 * `/robots.txt` and the raw Markdown of a page at `/{path}.md`. Each answer
 * depends only on the hostname, the path and the published version. They
 * have their own cache entrypoint,
 * `DocsTextCache`, because the HTML entrypoint accepts only HTML requests and
 * HTML responses, and a new HTML prop would change every HTML key.
 */
export type DocsTextRoute = "llms" | "llms-full" | "sitemap" | "robots" | "md";

/**
 * Increase this value when the cached text response changes shape. With
 * `cross_version_cache`, older and newer deploys share one key otherwise.
 */
export const DOCS_TEXT_CACHE_FORMAT = 1;

/** Set only by the dispatcher. Together with the URL, they form the cache key. */
export interface TextCacheProps {
  hostname: string;
  rendererBuildId: string;
  resolution: DocsDomainResolution;
  route: DocsTextRoute;
  /** The version identity of the delivery, if delivery is active. */
  deliveryRenderId: string | null;
  format: number;
}

export interface TextRouteCacheEnv {
  DOXA_PROD_TEXT_ROUTE_CACHE_MODE?: string;
  DOXA_PROD_TEXT_ROUTE_CACHE_SITE_IDS?: string;
}

const EXACT_TEXT_ROUTES: ReadonlyMap<string, DocsTextRoute> = new Map([
  ["/llms.txt", "llms"],
  ["/llms-full.txt", "llms-full"],
  ["/sitemap.xml", "sitemap"],
  ["/robots.txt", "robots"],
]);

/** The one content type that each route may store. */
const TEXT_ROUTE_CONTENT_TYPES: Readonly<Record<DocsTextRoute, string>> = {
  llms: "text/plain",
  "llms-full": "text/plain",
  sitemap: "application/xml",
  robots: "text/plain",
  md: "text/markdown",
};

const MARKDOWN_SUFFIX = ".md";
// No dot, `%` or backslash: one `.md` suffix, no encoded or dot segments.
const MARKDOWN_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const REQUEST_DEPENDENT_HEADERS = ["cookie", "authorization", "range"] as const;
const RESPONSE_CACHE_HEADERS = [
  "cache-control",
  "cdn-cache-control",
  "cloudflare-cdn-cache-control",
] as const;

export function readTextRouteCacheRollout(
  env: TextRouteCacheEnv,
  warn: (message: string) => void = console.warn,
): SiteRollout {
  return {
    mode: parseRolloutMode(env.DOXA_PROD_TEXT_ROUTE_CACHE_MODE, (invalid) =>
      warn(
        `[doxa-docs-dispatcher] Invalid DOXA_PROD_TEXT_ROUTE_CACHE_MODE ${JSON.stringify(invalid)}; text routes are not cached.`,
      ),
    ),
    siteIds: parseSiteAllowlist(env.DOXA_PROD_TEXT_ROUTE_CACHE_SITE_IDS),
  };
}

/** The text route of an exact request path, or null for every other path. */
export function matchDocsTextRoute(pathname: string): DocsTextRoute | null {
  return (
    EXACT_TEXT_ROUTES.get(pathname) ??
    (isMarkdownPagePath(pathname) ? "md" : null)
  );
}

function isMarkdownPagePath(pathname: string): boolean {
  if (!pathname.startsWith("/") || !pathname.endsWith(MARKDOWN_SUFFIX)) {
    return false;
  }
  const pagePath = pathname.slice(0, -MARKDOWN_SUFFIX.length);
  if (isRendererApiRoute(pagePath)) return false;
  return pagePath
    .slice(1)
    .split("/")
    .every(
      (segment) =>
        MARKDOWN_SEGMENT_PATTERN.test(segment) && !segment.startsWith("_"),
    );
}

/**
 * The text route of a visitor request that may share a cached response, or
 * null. The request must not depend on the visitor: no query, no cookie, no
 * authorization and no range.
 */
export function matchCacheableDocsTextRequest(
  request: Request,
): DocsTextRoute | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  if (url.protocol !== "https:" || url.search) return null;
  if (REQUEST_DEPENDENT_HEADERS.some((name) => request.headers.has(name))) {
    return null;
  }
  return matchDocsTextRoute(url.pathname);
}

export function isCacheableDocsTextRequest(request: Request): boolean {
  return matchCacheableDocsTextRequest(request) !== null;
}

/**
 * The text route of a visitor request that `DocsTextCache` may answer, or
 * null. Unlike `matchCacheableDocsTextRequest`, a query, a cookie, an
 * authorization header and a range do not stop it: for a public production
 * site the renderer's text responses depend only on the host and the path
 * (`llms.ts` reads the URL origin, `raw-markdown.ts` the path; the cookie is
 * read only by the access gate, which runs for preview hosts only), and the
 * cache sees only the canonical request, which drops them all. A `Range` is
 * ignored: the visitor gets the full 200, as the renderer, which has no range
 * support, would answer. Routing these requests uncached would let anyone
 * render llms-full.txt on every request in the shared isolate (FS-M2).
 */
export function matchRoutableDocsTextRequest(
  request: Request,
): DocsTextRoute | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  if (url.protocol !== "https:") return null;
  return matchDocsTextRoute(url.pathname);
}

/**
 * The text route to serve through `DocsTextCache`, or null when the request
 * must render uncached: not a text route request, not public production, or
 * a site outside the rollout. Private and preview sites keep the uncached
 * path, where the visitor's cookie reaches the access gate.
 */
export function selectDocsTextCacheRoute(
  request: Request,
  resolution: DocsDomainResolution,
  rollout: SiteRollout,
): DocsTextRoute | null {
  if (
    !isPublicProduction(resolution) ||
    !isSiteInRollout(rollout, resolution.siteId)
  ) {
    return null;
  }
  return matchRoutableDocsTextRequest(request);
}

export function createTextCacheProps(
  request: Request,
  resolution: DocsDomainResolution,
  identity: Pick<
    TextCacheProps,
    "rendererBuildId" | "deliveryRenderId" | "route"
  >,
): TextCacheProps {
  // Workers Cache does not include the URL hostname in its default key.
  return {
    hostname: new URL(request.url).hostname,
    rendererBuildId: identity.rendererBuildId,
    resolution,
    route: identity.route,
    deliveryRenderId: identity.deliveryRenderId,
    format: DOCS_TEXT_CACHE_FORMAT,
  };
}

/**
 * The one request shape that fills the text cache: built from scratch, always
 * `GET`, a fixed `accept`, no query and no visitor header. The gateway removes
 * the body for a visitor `HEAD`.
 */
export function createCanonicalTextRequest(request: Request): Request {
  const url = new URL(request.url);
  return new Request(`${url.origin}${url.pathname}`, {
    method: "GET",
    headers: { accept: "*/*" },
  });
}

/** Only the canonical request of the deployed build may fill an entry. */
/** The build check is part of the entrypoint protocol, not of this check. */
export function isTrustedDocsTextCacheRequest(
  request: Request,
  props: TextCacheProps,
): boolean {
  const { hostname, resolution, route, format } = props;
  return (
    request.method === "GET" &&
    request.headers.get("accept") === "*/*" &&
    matchCacheableDocsTextRequest(request) === route &&
    format === DOCS_TEXT_CACHE_FORMAT &&
    isPublicProduction(resolution) &&
    hostname === new URL(request.url).hostname &&
    resolution.hostname === hostname
  );
}

/**
 * Stores only a 200 with the exact content type of the route, for the
 * versioned lifetime. Everything else, including an HTML response (an `.md`
 * path with raw Markdown off falls through to the HTML pages), is `no-store`.
 */
export function withDocsTextCachePolicy(
  response: Response,
  route: DocsTextRoute,
): Response {
  if (
    response.status !== 200 ||
    readBaseContentType(response) !== TEXT_ROUTE_CONTENT_TYPES[route] ||
    response.headers.has("set-cookie") ||
    response.headers.has("vary") ||
    isExplicitlyUncacheable(response)
  ) {
    return withoutResponseCaching(response);
  }
  const headers = new Headers(response.headers);
  const cacheControl = cacheControlFor("versioned");
  for (const header of RESPONSE_CACHE_HEADERS) headers.set(header, cacheControl);
  headers.delete("cache-tag");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function readBaseContentType(response: Response): string | undefined {
  return response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
}

function isExplicitlyUncacheable(response: Response): boolean {
  return RESPONSE_CACHE_HEADERS.some((header) =>
    /\b(private|no-store|no-cache)\b/i.test(response.headers.get(header) ?? ""),
  );
}
