import type { DocsContentBinding } from "./binding-runtime-source";

/**
 * Internal response header with the timing of one dispatcher-pinned render.
 * The dispatcher reads it into its `docs_renderer_load` log line and removes
 * it, so it never reaches a cache or a visitor.
 */
export const RENDERER_TIMING_HEADER = "x-doxa-renderer-timing";

/** What the renderer saw of one request. Times are epoch milliseconds. */
export interface RendererTimingReport {
  /** Random per isolate, so log lines show which requests shared one. */
  isolateId: string;
  /** Requests this isolate has handled, this one included. */
  isolateRequests: number;
  /** Time since this isolate handled its first request. */
  isolateAgeMs: number;
  requestStartedAt: number;
  routeDataMs?: number;
  siteConfigMs?: number;
  contentCalls: number;
  contentMs: number;
  longestContentMs: number;
  respondedAt: number;
}

export type RendererTimingPhase = "routeDataMs" | "siteConfigMs";

/**
 * Collects the timing of one request. Inside a Worker the clock moves only on
 * I/O, so every mark is taken at an I/O boundary: the request arrival, each
 * content RPC result and the handler's end. CPU work after the last I/O,
 * such as rendering the page shell, shows in the dispatcher as the time from
 * `respondedAt` to the response.
 */
export interface RendererTiming {
  /** Times every content RPC that goes through the returned binding. */
  wrapContent(binding: DocsContentBinding): DocsContentBinding;
  measure<T>(phase: RendererTimingPhase, operation: () => Promise<T>): Promise<T>;
  /** Copies the response with the timing header added. */
  attach(response: Response): Response;
}

interface IsolateState {
  id: string;
  firstRequestAt: number;
  requests: number;
}

// Set on the first request: the global scope cannot create random values,
// and its clock does not show when the isolate started.
let isolate: IsolateState | undefined;

function recordIsolateRequest(now: number): IsolateState {
  isolate ??= {
    id: crypto.randomUUID().slice(0, 8),
    firstRequestAt: now,
    requests: 0,
  };
  isolate.requests += 1;
  return isolate;
}

export function startRendererTiming(now: () => number = Date.now): RendererTiming {
  const requestStartedAt = now();
  const isolateState = recordIsolateRequest(requestStartedAt);
  const phases: Partial<Record<RendererTimingPhase, number>> = {};
  const content = { calls: 0, totalMs: 0, longestMs: 0 };

  const timeContentCall = async <T>(call: () => Promise<T>): Promise<T> => {
    const startedAt = now();
    try {
      return await call();
    } finally {
      const durationMs = now() - startedAt;
      content.calls += 1;
      content.totalMs += durationMs;
      content.longestMs = Math.max(content.longestMs, durationMs);
    }
  };

  return {
    wrapContent(binding) {
      const { asset, versionAsset } = binding;
      return {
        request: (input) => timeContentCall(() => binding.request(input)),
        ...(asset
          ? { asset: (input) => timeContentCall(() => asset.call(binding, input)) }
          : {}),
        ...(versionAsset
          ? {
              versionAsset: (input) =>
                timeContentCall(() => versionAsset.call(binding, input)),
            }
          : {}),
      };
    },
    async measure(phase, operation) {
      const startedAt = now();
      try {
        return await operation();
      } finally {
        phases[phase] = now() - startedAt;
      }
    },
    attach(response) {
      const report: RendererTimingReport = {
        isolateId: isolateState.id,
        isolateRequests: isolateState.requests,
        isolateAgeMs: requestStartedAt - isolateState.firstRequestAt,
        requestStartedAt,
        ...phases,
        contentCalls: content.calls,
        contentMs: content.totalMs,
        longestContentMs: content.longestMs,
        respondedAt: now(),
      };
      const headers = new Headers(response.headers);
      headers.set(RENDERER_TIMING_HEADER, JSON.stringify(report));
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
}

/** Test hook: forget the isolate state between tests. */
export function resetRendererTimingIsolateForTests(): void {
  isolate = undefined;
}
