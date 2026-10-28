import type { DocsHostResolution } from "@doxahq/contracts";

import { isPrerenderableDocsRequest } from "./cache-policy";
import {
  isSiteInRollout,
  parseRolloutMode,
  parseSiteAllowlist,
  type SiteRollout,
} from "./rollout-policy";
import type {
  DocsRuntimeRpc,
  RuntimeRequest,
  RuntimeResponse,
} from "./worker-exports";

/**
 * Route-data prefetch for cold renderer starts.
 *
 * A cold renderer asks for its route data only after its own start. When the
 * dispatcher starts a cold renderer, it sends the same `getRouteData` call to
 * docs-runtime at once, pinned to the same trusted resolution. When the
 * renderer's call reaches `ScopedDocsContent` in this dispatcher isolate, it
 * gets the prefetched answer. Otherwise the renderer calls docs-runtime itself
 * and finds its isolate and caches warm.
 */
export interface RouteDataPrefetchEnv {
  DOXA_PROD_ROUTE_DATA_PREFETCH_MODE?: string;
  DOXA_PROD_ROUTE_DATA_PREFETCH_SITE_IDS?: string;
}

/** What one request may prefetch. The ID goes into the content props. */
export interface RouteDataPrefetchPlan {
  id: string;
  payload: RouteDataPayload;
}

interface RouteDataPayload {
  pathname: string;
}

/**
 * How the prefetch of one render went, for `docs_renderer_load`.
 * - `handedOff`: the renderer got the prefetched answer.
 * - `fellBack`: the renderer asked here, but the prefetch failed, so it called
 *   docs-runtime itself.
 * - `notTaken`: the renderer's call reached another dispatcher isolate, or
 *   asked for other data; the prefetch only warmed docs-runtime.
 */
export interface RouteDataPrefetchReport {
  outcome: "handedOff" | "fellBack" | "notTaken";
  /** Duration of the prefetch RPC, when it ended before the report. */
  prefetchMs?: number;
  /** Prefetch start until the renderer asked for route data. */
  leadMs?: number;
  /** How long the renderer waited for the prefetched answer. */
  waitMs?: number;
}

const OPERATION = "getRouteData";
const ENTRY_TTL_MS = 60_000;
const MAX_ENTRIES = 64;

export function readRouteDataPrefetchRollout(
  env: RouteDataPrefetchEnv,
  warn: (message: string) => void = console.warn,
): SiteRollout {
  return {
    mode: parseRolloutMode(env.DOXA_PROD_ROUTE_DATA_PREFETCH_MODE, (invalid) =>
      warn(
        `[doxa-docs-dispatcher] Invalid DOXA_PROD_ROUTE_DATA_PREFETCH_MODE ${JSON.stringify(invalid)}; route data is not prefetched.`,
      ),
    ),
    siteIds: parseSiteAllowlist(env.DOXA_PROD_ROUTE_DATA_PREFETCH_SITE_IDS),
  };
}

/**
 * Plans a prefetch for a page request of a site in the rollout. Returns null
 * for every request for which docs-template sends no `getRouteData`.
 */
export function planRouteDataPrefetch(input: {
  request: Request;
  siteId: string;
  rollout: SiteRollout;
  createId?: () => string;
}): RouteDataPrefetchPlan | null {
  const { request, siteId, rollout } = input;
  if (!isSiteInRollout(rollout, siteId)) return null;
  // docs-template asks for route data only for a GET that accepts HTML.
  if (request.method !== "GET" || !isPrerenderableDocsRequest(request)) {
    return null;
  }
  return {
    id: (input.createId ?? (() => crypto.randomUUID()))(),
    payload: { pathname: toRuntimeHref(new URL(request.url).pathname) },
  };
}

/**
 * The pathname that docs-template sends. Mirrors `normalizeRuntimeHref` in
 * `apps/docs-template/src/runtime/runtime-source.ts`. A difference only costs
 * the handoff: the payloads must be equal.
 */
export function toRuntimeHref(value: string): string {
  const clean = value
    .trim()
    .split(/[?#]/, 1)[0]
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/(?:^|\/)index(?:\.mdx?)?$/i, "");
  const normalized = clean.replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized ? `/${normalized}` : "/";
}

interface PrefetchEntry {
  resolution: DocsHostResolution;
  payloadKey: string;
  /** Never rejects: undefined means the RPC threw. */
  result: Promise<RuntimeResponse | undefined>;
  startedAt: number;
  settledAt?: number;
  ok?: boolean;
  takenAt?: number;
}

/**
 * The prefetches in flight in one dispatcher isolate. Entries live until the
 * render that started them reports, or one minute at most.
 */
export class RouteDataPrefetches {
  private readonly entries = new Map<string, PrefetchEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Starts the RPC. Returns a promise that ends with it, for `waitUntil`;
   * it never rejects.
   */
  start(input: {
    plan: RouteDataPrefetchPlan;
    runtime: Pick<DocsRuntimeRpc, "request">;
    resolution: DocsHostResolution;
  }): Promise<void> {
    this.prune();
    const { plan, runtime, resolution } = input;
    const entry: PrefetchEntry = {
      resolution,
      payloadKey: JSON.stringify(plan.payload),
      startedAt: this.now(),
      result: Promise.resolve(undefined),
    };
    entry.result = runtime
      .request({ resolution, operation: OPERATION, payload: plan.payload })
      .then(
        (response) => this.settle(entry, response),
        () => this.settle(entry, undefined),
      );
    this.entries.set(plan.id, entry);
    return entry.result.then(() => undefined);
  }

  /**
   * Answers one content call of a renderer. Only the first `getRouteData`
   * call with the prefetched payload and resolution gets the prefetched
   * answer, and only when it succeeded. Every other call runs `call`.
   */
  serve(
    id: string | undefined,
    resolution: DocsHostResolution,
    input: RuntimeRequest,
    call: () => Promise<RuntimeResponse>,
  ): Promise<RuntimeResponse> {
    const entry = id === undefined ? undefined : this.entries.get(id);
    if (
      !entry ||
      entry.takenAt !== undefined ||
      input.operation !== OPERATION ||
      JSON.stringify(input.payload ?? null) !== entry.payloadKey ||
      !isSameResolution(entry.resolution, resolution)
    ) {
      return call();
    }
    entry.takenAt = this.now();
    return entry.result.then((response) =>
      response?.ok ? response : call(),
    );
  }

  /** Removes the entry and reports how it was used. */
  finish(id: string): RouteDataPrefetchReport | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    return toReport(entry);
  }

  get size(): number {
    return this.entries.size;
  }

  private settle(
    entry: PrefetchEntry,
    response: RuntimeResponse | undefined,
  ): RuntimeResponse | undefined {
    entry.settledAt = this.now();
    entry.ok = response?.ok === true;
    return response;
  }

  private prune(): void {
    const oldest = this.now() - ENTRY_TTL_MS;
    for (const [id, entry] of this.entries) {
      if (entry.startedAt < oldest || this.entries.size >= MAX_ENTRIES) {
        this.entries.delete(id);
      }
    }
  }
}

function toReport(entry: PrefetchEntry): RouteDataPrefetchReport {
  const { startedAt, settledAt, takenAt } = entry;
  return {
    outcome:
      takenAt === undefined
        ? "notTaken"
        : entry.ok === false
          ? "fellBack"
          : "handedOff",
    ...(settledAt !== undefined ? { prefetchMs: settledAt - startedAt } : {}),
    ...(takenAt !== undefined ? { leadMs: takenAt - startedAt } : {}),
    ...(takenAt !== undefined && settledAt !== undefined
      ? { waitMs: Math.max(0, settledAt - takenAt) }
      : {}),
  };
}

function isSameResolution(
  left: DocsHostResolution,
  right: DocsHostResolution,
): boolean {
  return (
    left.siteId === right.siteId &&
    left.projectId === right.projectId &&
    left.publishedVersionId === right.publishedVersionId &&
    left.artifactPrefix === right.artifactPrefix &&
    left.manifestPath === right.manifestPath &&
    left.accessPolicy === right.accessPolicy
  );
}

/** The registry of this dispatcher isolate. */
export const routeDataPrefetches = new RouteDataPrefetches();
