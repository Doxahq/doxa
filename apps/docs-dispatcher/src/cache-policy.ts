import type {
  DocsCacheInvalidation,
  DocsDomainResolution,
} from "@doxahq/contracts";

// The hostname TTL is a freshness trade-off, not an invalidation guarantee.
// Keep these together so the early cache policy has one place to change.
const DOCS_CACHE_POLICY = {
  hostnameTtlSeconds: 3_600,
  versionedTtlSeconds: 86_400,
  versionedStaleSeconds: 604_800,
  liveFallbackTtlSeconds: 30,
} as const;

/**
 * - `hostname`: a mutable hostname → version mapping. It must never be served
 *   stale, because a publish changes it.
 * - `versioned`: output keyed by an immutable version identity. A stale copy is
 *   identical to a fresh one, so it can be served while it refreshes.
 * - `liveFallback`: live output that repaired saved output must replace soon.
 */
export type DocsCacheLifetime = "hostname" | "versioned" | "liveFallback";

/** Lifetimes for rendered docs output, as opposed to the hostname mapping. */
export type ContentCacheLifetime = Exclude<DocsCacheLifetime, "hostname">;

const CONTENT_CACHE_LIFETIMES: readonly ContentCacheLifetime[] = [
  "versioned",
  "liveFallback",
];

export function isContentCacheLifetime(
  value: unknown,
): value is ContentCacheLifetime {
  return CONTENT_CACHE_LIFETIMES.some((lifetime) => lifetime === value);
}

export interface HtmlCacheProps {
  hostname: string;
  rendererBuildId: string;
  resolution: DocsDomainResolution;
  lifetime: ContentCacheLifetime;
  /** The version identity embedded in the HTML, if delivery is active. */
  deliveryRenderId: string | null;
}

export type HtmlCacheIdentity = Pick<
  HtmlCacheProps,
  "rendererBuildId" | "deliveryRenderId"
> &
  Partial<Pick<HtmlCacheProps, "lifetime">>;

const NO_STORE = "private, no-store";
const CACHE_HEADERS = [
  "cache-control",
  "cdn-cache-control",
  "cloudflare-cdn-cache-control",
] as const;
const REQUEST_DEPENDENT_HEADERS = [
  "cookie",
  "authorization",
  "range",
  "upgrade",
] as const;
const REQUEST_CACHE_DIRECTIVE_HEADERS = ["cache-control", "pragma"] as const;

export function isPublicProduction(
  resolution: DocsDomainResolution | null,
): boolean {
  return (
    resolution?.renderTarget === "production" &&
    resolution.accessPolicy === "public"
  );
}

export function isCacheableDocsRequest(request: Request): boolean {
  return (
    isPrerenderableDocsRequest(request) &&
    !hasAnyRequestHeader(request, REQUEST_CACHE_DIRECTIVE_HEADERS)
  );
}

export function isPrerenderableDocsRequest(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const url = new URL(request.url);
  if (url.protocol !== "https:" || url.search) return false;
  if (!request.headers.get("accept")?.includes("text/html")) return false;
  // No request-dependent responses in this first version. All query strings
  // bypass too, including demo mode and framework loader/server-function data.
  if (hasAnyRequestHeader(request, REQUEST_DEPENDENT_HEADERS)) return false;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  return !pathname
    .split("/")
    .some(
      (segment) =>
        segment === "api" ||
        segment.startsWith("_") ||
        segment.includes(".") ||
        segment.includes("%") ||
        segment.includes("\\"),
    );
}

function hasAnyRequestHeader(
  request: Request,
  headers: readonly string[],
): boolean {
  return headers.some((header) => request.headers.has(header));
}

export function createHtmlCacheProps(
  request: Request,
  resolution: DocsDomainResolution,
  identity: HtmlCacheIdentity,
): HtmlCacheProps {
  // Workers Cache does not include the URL hostname in its default key.
  // Trusted ctx.props partition by hostname, the pinned content and build,
  // and the version identity that the HTML embeds.
  return {
    hostname: new URL(request.url).hostname,
    rendererBuildId: identity.rendererBuildId,
    resolution,
    lifetime: identity.lifetime ?? "versioned",
    deliveryRenderId: identity.deliveryRenderId,
  };
}

export function withHostCachePolicy(
  resolution: DocsDomainResolution | null,
): Response {
  const response = Response.json(resolution, {
    headers: {
      "cache-control": isPublicProduction(resolution)
        ? cacheControlFor("hostname")
        : NO_STORE,
    },
  });
  if (resolution && isPublicProduction(resolution)) {
    response.headers.set(
      "cache-tag",
      createDocsCacheTags(resolution).join(","),
    );
  }
  return response;
}

export function createDocsCacheTags(input: DocsCacheInvalidation): string[] {
  const tags = [`docs-site:${encodeURIComponent(input.siteId)}`];
  if (input.hostname) {
    const hostname = input.hostname.toLowerCase().replace(/\.$/, "");
    tags.push(`docs-host:${encodeURIComponent(hostname)}`);
  }
  return tags;
}

export function withHtmlCachePolicy(
  response: Response,
  lifetime: ContentCacheLifetime = "versioned",
): Response {
  const contentType = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  const explicitlyUncacheable = CACHE_HEADERS.some((header) =>
    /\b(private|no-store|no-cache)\b/i.test(response.headers.get(header) ?? ""),
  );
  if (
    response.status !== 200 ||
    contentType !== "text/html" ||
    response.headers.has("set-cookie") ||
    response.headers.has("vary") ||
    explicitlyUncacheable
  ) {
    return withoutResponseCaching(response);
  }
  return withCacheControl(response, cacheControlFor(lifetime));
}

export function withRouteDataCachePolicy(
  response: Response,
  lifetime: ContentCacheLifetime,
): Response {
  const contentType = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (
    response.status !== 200 ||
    contentType !== "application/json" ||
    response.headers.has("set-cookie") ||
    response.headers.has("vary")
  ) {
    return withoutResponseCaching(response);
  }
  return withCacheControl(response, cacheControlFor(lifetime));
}

export function withoutResponseCaching(response: Response): Response {
  return withCacheControl(response, NO_STORE);
}

export function cacheControlFor(lifetime: DocsCacheLifetime): string {
  switch (lifetime) {
    case "hostname":
      return strictCacheControl(DOCS_CACHE_POLICY.hostnameTtlSeconds);
    case "liveFallback":
      return strictCacheControl(DOCS_CACHE_POLICY.liveFallbackTtlSeconds);
    case "versioned":
      // No must-revalidate, s-maxage, or proxy-revalidate: each one disables
      // stale serving in Workers Cache.
      return [
        "public",
        `max-age=${DOCS_CACHE_POLICY.versionedTtlSeconds}`,
        `stale-while-revalidate=${DOCS_CACHE_POLICY.versionedStaleSeconds}`,
        `stale-if-error=${DOCS_CACHE_POLICY.versionedStaleSeconds}`,
      ].join(", ");
  }
}

function strictCacheControl(seconds: number): string {
  return `public, max-age=${seconds}, must-revalidate`;
}

function withCacheControl(response: Response, value: string): Response {
  const headers = new Headers(response.headers);
  for (const header of CACHE_HEADERS) headers.set(header, value);
  headers.delete("cache-tag");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
