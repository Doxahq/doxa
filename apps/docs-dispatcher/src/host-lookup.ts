import {
  docsDomainResolutionSchema,
  type DocsDomainResolution,
} from "@doxahq/contracts";

import { DOCS_HOST_CACHE_FORMAT } from "./cache-policy";
import {
  compareHostnameMap,
  lookupHostnameMap,
  type HostnameMapAgreement,
  type HostnameMapMode,
  type HostnameMapStatus,
  type HostnameMapStore,
} from "./hostname-map";
import { getWorkerExports } from "./worker-exports";

/** Which layer answered the hostname lookup. */
export type HostSource = "kv" | "cache" | "resolver";

export interface HostLookupFacts {
  source: HostSource;
  /** `CF-Cache-Status` of `DocsHostCache`; `BYPASS` when it was not called. */
  hostCacheStatus: string;
  /** Present when the hostname map is in `shadow` or `on` mode. */
  hostnameMap?: {
    mode: Exclude<HostnameMapMode, "off">;
    status: HostnameMapStatus;
    /** Shadow mode only. */
    agreement?: HostnameMapAgreement;
  };
}

export interface HostLookup {
  resolution: DocsDomainResolution | null;
  facts: HostLookupFacts;
}

export interface HostCacheRead {
  resolution: DocsDomainResolution | null;
  cacheStatus: string;
}

/**
 * Resolves a hostname: from the hostname map in `on` mode, else (and on any
 * map miss or error) from `DocsHostCache`, which calls the resolver on a miss.
 */
export async function lookupHost(input: {
  hostname: string;
  mode: HostnameMapMode;
  store: HostnameMapStore | undefined;
  now: number;
  readHostCache: () => Promise<HostCacheRead>;
}): Promise<HostLookup> {
  const { hostname, mode, store, now, readHostCache } = input;
  if (mode === "off") return fromHostCache(await readHostCache());

  if (mode === "shadow") {
    const [map, cached] = await Promise.all([
      lookupHostnameMap(store, hostname, now),
      readHostCache(),
    ]);
    return fromHostCache(cached, {
      mode,
      status: map.status,
      agreement: compareHostnameMap(hostname, map, cached.resolution),
    });
  }

  const map = await lookupHostnameMap(store, hostname, now);
  if (map.status === "hit") {
    return {
      resolution: map.resolution,
      facts: {
        source: "kv",
        hostCacheStatus: "BYPASS",
        hostnameMap: { mode, status: map.status },
      },
    };
  }
  return fromHostCache(await readHostCache(), { mode, status: map.status });
}

/**
 * The resolution depends only on the hostname, and the entrypoint stores
 * public production mappings only. Visitor-specific requests can share it;
 * they still bypass the HTML cache.
 */
export async function readHostCache(
  ctx: ExecutionContext,
  hostname: string,
): Promise<HostCacheRead> {
  const cached = await getWorkerExports(ctx)
    .DocsHostCache({ props: { hostname, format: DOCS_HOST_CACHE_FORMAT } })
    .fetch("https://docs-cache.internal/resolve");
  const cacheStatus = cached.headers.get("cf-cache-status") ?? "UNAVAILABLE";
  if (!cached.ok) throw new Error("Hostname cache lookup failed");
  return {
    resolution: docsDomainResolutionSchema
      .nullable()
      .parse(await cached.json()),
    cacheStatus,
  };
}

/** Diagnostic header: which layer answered the hostname lookup. */
export function setHostDiagnostics(
  headers: Headers,
  hostCacheStatus: string,
  facts: HostLookupFacts | undefined,
): void {
  headers.set("x-doxa-host-cache", hostCacheStatus);
  if (facts) headers.set("x-doxa-host-source", facts.source);
}

function fromHostCache(
  cached: HostCacheRead,
  hostnameMap?: HostLookupFacts["hostnameMap"],
): HostLookup {
  return {
    resolution: cached.resolution,
    facts: {
      source: hostSourceFor(cached.cacheStatus),
      hostCacheStatus: cached.cacheStatus,
      ...(hostnameMap ? { hostnameMap } : {}),
    },
  };
}

/**
 * A stored answer (fresh or stale) came from the cache. Anything else,
 * including `UNAVAILABLE`, may have called the resolver.
 */
export function hostSourceFor(cacheStatus: string): HostSource {
  return cacheStatus === "HIT" ||
    cacheStatus === "STALE" ||
    cacheStatus === "UPDATING"
    ? "cache"
    : "resolver";
}
