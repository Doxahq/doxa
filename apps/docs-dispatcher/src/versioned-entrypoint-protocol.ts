import { cacheControlFor, withoutResponseCaching } from "./cache-policy";

/**
 * The protocol of every cache entrypoint that stores versioned output
 * (`DocsHtmlCache`, `DocsRouteDataCache`, `DocsPrerenderCache`, and the text
 * cache). Spike S2 measured each rule; see
 * docs/current/production-docs-caching.md, "Entrypoint protocol".
 *
 * 1. ETag/304: every stored versioned response carries a strong ETag derived
 *    from its identity (the props). A trusted request whose `If-None-Match`
 *    matches gets a 304 before the build check. Only Cloudflare's stale-
 *    while-revalidate refresh sends `If-None-Match` (the dispatcher builds
 *    every canonical request from scratch), and a refresh that a probe
 *    started names the previous build: without the 304 it would be rejected
 *    and delete the stored entry (F39). The trust check runs first, so an
 *    untrusted call never learns whether its ETag matches (FS-L2).
 * 2. Probe: `x-doxa-cache-probe: 1` asks "is this key stored here?" without
 *    a fill. Workers Cache answers a HIT itself; on a miss the entrypoint
 *    returns 204 with the marker and `private, no-store`, never renders and
 *    never reads R2. The marker is never cacheable (F40).
 * 3. Build check (F14): the deployed build or release, or the previous one
 *    only with a probe. A real call never renders the deployed code under an
 *    older key.
 *
 * Probe only keys that nobody fills (previous-build keys): a probe miss stops
 * concurrent real calls of that key from collapsing and from being stored
 * for over a minute (F38).
 */

export const CACHE_PROBE_HEADER = "x-doxa-cache-probe";

/** Bump to give every ETag a new value, for example after a body format change. */
const IDENTITY_ETAG_FORMAT = 1;

export type VersionedEntrypointName =
  | "DocsHtmlCache"
  | "DocsRouteDataCache"
  | "DocsPrerenderCache"
  | "DocsTextCache";

export interface BuildCheck {
  /** The build or release ID that the props carry. */
  requested: string;
  /** The deployed build or release ID. */
  deployed: string | null;
  /** The previous build or release ID, accepted only for a probe. */
  previous: string | null;
}

export interface VersionedEntrypointCall<Props> {
  entrypoint: VersionedEntrypointName;
  request: Request;
  props: Props;
  build: BuildCheck;
  /** The entrypoint's own trust checks: request shape, props, rollout. */
  isTrusted(): boolean;
  /** Called once when a trusted call names a build that is not accepted. */
  onBuildRejected?(reason: BuildRejection): void;
  /** The body of a rejected call. */
  rejection: string;
  /** Produces the response to store. Runs only for an accepted real call. */
  fill(): Promise<Response>;
}

/** Runs one versioned entrypoint call through the protocol. */
export async function serveVersionedEntrypoint<Props>(
  call: VersionedEntrypointCall<Props>,
): Promise<Response> {
  // The 304 comes first, before the trust check. The ETag is derived from
  // the props, which only the dispatcher sets, and no visitor header reaches
  // an entrypoint (canonical requests are built from scratch). A refresh
  // that Cloudflare replays with headers the trust check refuses (for
  // example `cache-control` or `pragma`) must still get its 304: a 400
  // would delete the stored entry (F39, fix-round note N2).
  const etag = await createIdentityEtag(call.entrypoint, call.props);
  if (matchesEtag(call.request, etag)) return createNotModified(etag);
  if (!call.isTrusted()) return rejectCall(call);
  const probe = isCacheProbeRequest(call.request);
  const buildRejection = rejectedBuild(call.build, probe);
  if (buildRejection) {
    call.onBuildRejected?.(buildRejection);
    return rejectCall(call);
  }
  if (probe) return createCacheProbeMiss();
  return withIdentityEtag(await call.fill(), etag);
}

function rejectCall<Props>(call: VersionedEntrypointCall<Props>): Response {
  return withoutResponseCaching(new Response(call.rejection, { status: 400 }));
}

/** No deployed build is configured, or the call names another build. */
export type BuildRejection = "unconfigured" | "mismatch";

/** Why the build of a call is not accepted, or `null` when it is. */
export function rejectedBuild(
  check: BuildCheck,
  probe: boolean,
): BuildRejection | null {
  if (isAcceptedBuild(check, probe)) return null;
  return check.deployed === null ? "unconfigured" : "mismatch";
}

export function isAcceptedBuild(check: BuildCheck, probe: boolean): boolean {
  if (check.deployed !== null && check.requested === check.deployed) {
    return true;
  }
  return (
    probe && check.previous !== null && check.requested === check.previous
  );
}

export function isCacheProbeRequest(request: Request): boolean {
  return request.headers.get(CACHE_PROBE_HEADER) === "1";
}

/** A copy of a canonical cache request that only asks whether it is stored. */
export function withCacheProbe(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set(CACHE_PROBE_HEADER, "1");
  return new Request(request.url, { method: request.method, headers });
}

export function createCacheProbeMiss(): Response {
  return withoutResponseCaching(
    new Response(null, {
      status: 204,
      headers: { [CACHE_PROBE_HEADER]: "miss" },
    }),
  );
}

export function isCacheProbeMiss(response: Response): boolean {
  return response.headers.get(CACHE_PROBE_HEADER) === "miss";
}

/** A strong ETag from the entrypoint name and its props, stable across deploys. */
export async function createIdentityEtag(
  entrypoint: VersionedEntrypointName,
  props: unknown,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      canonicalJson({ entrypoint, format: IDENTITY_ETAG_FORMAT, props }),
    ),
  );
  return `"doxa${IDENTITY_ETAG_FORMAT}-${toHex(new Uint8Array(digest))}"`;
}

/** Sets the ETag on a response that is stored with the versioned lifetime. */
export function withIdentityEtag(response: Response, etag: string): Response {
  if (response.headers.get("cache-control") !== cacheControlFor("versioned")) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("etag", etag);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function matchesEtag(request: Request, etag: string): boolean {
  const value = request.headers.get("if-none-match");
  if (!value) return false;
  return value
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .includes(etag);
}

/** The 304 keeps the versioned lifetime, so the refresh renews the entry. */
function createNotModified(etag: string): Response {
  const cacheControl = cacheControlFor("versioned");
  return new Response(null, {
    status: 304,
    headers: {
      etag,
      "cache-control": cacheControl,
      "cdn-cache-control": cacheControl,
      "cloudflare-cdn-cache-control": cacheControl,
    },
  });
}

export type CacheProbeOutcome =
  | { status: "hit"; response: Response }
  | { status: "miss" };

/**
 * Sends one probe. Only a 200 without the marker is a hit; a marker, a
 * rejection or an error is a miss.
 */
export async function probeCache(
  fetchProbe: () => Promise<Response>,
): Promise<CacheProbeOutcome> {
  let response: Response;
  try {
    response = await fetchProbe();
  } catch {
    return { status: "miss" };
  }
  if (response.status === 200 && !isCacheProbeMiss(response)) {
    return { status: "hit", response };
  }
  await response.body?.cancel();
  return { status: "miss" };
}

/**
 * A real call can join a concurrent probe's miss and receive its marker: the
 * key was not filled. Retry once; after a second marker the caller produces
 * the response without the cache. S2 never saw this, so it is logged.
 */
export async function fetchWithoutProbeMarker(
  entrypoint: VersionedEntrypointName,
  fetchOnce: () => Promise<Response>,
): Promise<Response | null> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetchOnce();
    if (!isCacheProbeMiss(response)) return response;
    await response.body?.cancel();
    console.warn(
      JSON.stringify({
        event: "docs_cache_probe_marker_received",
        entrypoint,
        attempt,
      }),
    );
  }
  return null;
}

/** The marker is internal: it never reaches a visitor. */
export function withoutCacheProbeMarker(response: Response): Response {
  if (!response.headers.has(CACHE_PROBE_HEADER)) return response;
  const headers = new Headers(response.headers);
  headers.delete(CACHE_PROBE_HEADER);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, sortKeys(item)]),
  );
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
