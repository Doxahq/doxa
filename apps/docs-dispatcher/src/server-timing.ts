import type { HostLookupFacts } from "./host-lookup";

export interface ServerTimingEntry {
  name: string;
  durationMs: number;
  description?: string;
}

export interface ServerTimingRecorder {
  readonly enabled: boolean;
  add(name: string, durationMs: number, description?: string): void;
  entries(): readonly ServerTimingEntry[];
  headerValue(): string | null;
  measure<T>(
    name: string,
    operation: () => Promise<T> | T,
    description?: TimingDescription,
  ): Promise<T>;
}

type Clock = () => number;
type TimingDescription = string | (() => string | undefined);

// Cache fills need timing data at the gateway, but cache hits must never replay
// an older request's measurements as if they describe the current request.
const INTERNAL_SERVER_TIMING_HEADER = "x-doxa-internal-server-timing";

export function createServerTiming(
  debug: string | undefined,
  now: Clock = () => performance.now(),
): ServerTimingRecorder {
  const enabled = debug?.trim().toLowerCase() === "true";
  const measurements: ServerTimingEntry[] = [];
  const add = (
    name: string,
    durationMs: number,
    description?: string,
  ): void => {
    if (!enabled) return;
    measurements.push({
      name,
      durationMs: Math.max(0, durationMs),
      ...(description ? { description } : {}),
    });
  };

  return {
    enabled,
    add,
    entries() {
      return measurements;
    },
    headerValue() {
      if (!enabled || measurements.length === 0) return null;
      return measurements.map(formatEntry).join(", ");
    },
    async measure(name, operation, description) {
      if (!enabled) return operation();
      const startedAt = now();
      try {
        return await operation();
      } finally {
        add(name, now() - startedAt, resolveDescription(description));
      }
    },
  };
}

export function attachInternalServerTiming(
  response: Response,
  timing: ServerTimingRecorder,
): Response {
  const headers = new Headers(response.headers);
  const value = timing.enabled
    ? joinHeaderValues(headers.get("server-timing"), timing.headerValue())
    : null;
  headers.delete("server-timing");
  if (value) headers.set(INTERNAL_SERVER_TIMING_HEADER, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function exposeRequestTiming(
  result: Response,
  source: Response,
  timing: ServerTimingRecorder,
  cache: { usedHtmlCache: boolean; htmlCacheStatus: string },
): void {
  let sourceTiming = source.headers.get("server-timing");
  result.headers.delete(INTERNAL_SERVER_TIMING_HEADER);
  if (cache.usedHtmlCache) {
    result.headers.delete("server-timing");
    sourceTiming = isFreshHtmlCacheResponse(cache.htmlCacheStatus)
      ? source.headers.get(INTERNAL_SERVER_TIMING_HEADER)
      : null;
  }
  if (!timing.enabled) return;
  const value = joinHeaderValues(sourceTiming, timing.headerValue());
  if (value) result.headers.set("server-timing", value);
}

export function mergeFreshInternalServerTiming(
  timing: ServerTimingRecorder,
  source: Response,
  cacheStatus: string,
): void {
  if (!timing.enabled || !isFreshCacheResponse(cacheStatus)) return;
  for (const entry of readDoxaTimings(
    source.headers.get(INTERNAL_SERVER_TIMING_HEADER),
  )) {
    timing.add(entry.name, entry.durationMs, entry.description);
  }
}

export function logRequestTiming(
  request: Request,
  response: Response,
  timing: ServerTimingRecorder,
  cache: {
    hostCacheStatus: string;
    htmlCacheStatus: string;
    routeDataCacheStatus?: string;
    /** Absent when the request never resolved its hostname. */
    hostLookup?: HostLookupFacts | undefined;
  },
): void {
  const requestWithCloudflare = request as Request & {
    cf?: { colo?: string };
  };
  if (!timing.enabled) {
    // One short line per request, so production shows the hit rate per site
    // and per data center without DEBUG.
    console.info(
      JSON.stringify({
        event: "docs_request_cache",
        hostname: new URL(request.url).hostname,
        path: new URL(request.url).pathname,
        status: response.status,
        cache: {
          host: cache.hostCacheStatus,
          html: cache.htmlCacheStatus,
          ...(cache.routeDataCacheStatus
            ? { routeData: cache.routeDataCacheStatus }
            : {}),
        },
        ...hostLookupLogFields(cache.hostLookup),
        ...(requestWithCloudflare.cf?.colo
          ? { colo: requestWithCloudflare.cf.colo }
          : {}),
      }),
    );
    return;
  }
  console.info(
    JSON.stringify({
      event: "docs_request_timing",
      hostname: new URL(request.url).hostname,
      method: request.method,
      status: response.status,
      rendererMode: response.headers.get("x-doxa-renderer-mode"),
      cache: {
        host: cache.hostCacheStatus,
        html: cache.htmlCacheStatus,
        ...(cache.routeDataCacheStatus
          ? { routeData: cache.routeDataCacheStatus }
          : {}),
      },
      ...(response.headers.has("x-doxa-prerender-lookup")
        ? {
            prerender: {
              cache: response.headers.get("x-doxa-prerender-cache"),
              lookup: response.headers.get("x-doxa-prerender-lookup"),
              reason: response.headers.get("x-doxa-prerender-reason"),
            },
          }
        : {}),
      ...hostLookupLogFields(cache.hostLookup),
      ...(requestWithCloudflare.cf?.colo
        ? { colo: requestWithCloudflare.cf.colo }
        : {}),
      serverTiming: response.headers.get("server-timing"),
      timings: readDoxaTimings(response.headers.get("server-timing")),
    }),
  );
}

/** `hostSource`: kv, cache or resolver; `hostnameMap`: the map read and, in shadow mode, its agreement. */
function hostLookupLogFields(
  facts: HostLookupFacts | undefined,
): Record<string, unknown> {
  if (!facts) return {};
  return {
    hostSource: facts.source,
    ...(facts.hostnameMap ? { hostnameMap: facts.hostnameMap } : {}),
  };
}

function formatEntry(entry: ServerTimingEntry): string {
  const duration = Number(entry.durationMs.toFixed(2));
  const description = entry.description
    ? `;desc="${escapeDescription(entry.description)}"`
    : "";
  return `${entry.name};dur=${duration}${description}`;
}

function resolveDescription(
  description: TimingDescription | undefined,
): string | undefined {
  return typeof description === "function" ? description() : description;
}

function escapeDescription(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function isFreshHtmlCacheResponse(status: string): boolean {
  return isFreshCacheResponse(status);
}

function isFreshCacheResponse(status: string): boolean {
  return (
    status === "MISS" ||
    status === "BYPASS" ||
    status === "EXPIRED" ||
    status === "REVALIDATED"
  );
}

function joinHeaderValues(...values: Array<string | null>): string | null {
  const joined = values.filter((value): value is string => Boolean(value));
  return joined.length > 0 ? joined.join(", ") : null;
}

function readDoxaTimings(value: string | null): ServerTimingEntry[] {
  if (!value) return [];
  const measurements: ServerTimingEntry[] = [];
  const pattern =
    /(?:^|,\s*)(doxa_[a-z0-9_]+);dur=(\d+(?:\.\d+)?)(?:;desc="([^"]*)")?/g;
  for (const match of value.matchAll(pattern)) {
    const name = match[1];
    const duration = match[2];
    if (!name || !duration) continue;
    measurements.push({
      name,
      durationMs: Number(duration),
      ...(match[3] ? { description: match[3] } : {}),
    });
  }
  return measurements;
}
