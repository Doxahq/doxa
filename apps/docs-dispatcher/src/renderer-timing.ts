/**
 * Reads the renderer's own timing of one render. docs-template sets the
 * header in `src/runtime/renderer-timing.ts` for every dispatcher-pinned
 * render. Every response loses the header here, before it can reach Workers
 * Cache or a visitor.
 */
export const RENDERER_TIMING_HEADER = "x-doxa-renderer-timing";

/** What the renderer saw of one request. Times are epoch milliseconds. */
export interface RendererTimingReport {
  isolateId: string;
  isolateRequests: number;
  isolateAgeMs: number;
  requestStartedAt: number;
  routeDataMs?: number;
  siteConfigMs?: number;
  contentCalls: number;
  contentMs: number;
  longestContentMs: number;
  respondedAt: number;
}

/**
 * The split of one renderer call, in milliseconds. In a Worker the clock moves
 * only on I/O, so CPU work after the renderer's last I/O falls into
 * `afterHandlerMs`. Both clocks are Cloudflare clocks of different isolates.
 */
export interface RenderPhases {
  /** Dispatcher call → renderer handler start: code load, isolate start, hop. */
  beforeHandlerMs: number;
  /** Renderer handler start → handler end: content I/O and the CPU between. */
  handlerMs: number;
  /** Renderer handler end → response at the dispatcher: last render CPU. */
  afterHandlerMs: number;
  routeDataMs?: number;
  siteConfigMs?: number;
  contentCalls: number;
  contentMs: number;
  longestContentMs: number;
}

export interface RendererIsolateFacts {
  isolateId: string;
  isolateRequests: number;
  isolateAgeMs: number;
}

const REQUIRED_NUMBER_FIELDS = [
  "isolateRequests",
  "isolateAgeMs",
  "requestStartedAt",
  "contentCalls",
  "contentMs",
  "longestContentMs",
  "respondedAt",
] as const satisfies readonly (keyof RendererTimingReport)[];

const OPTIONAL_NUMBER_FIELDS = [
  "routeDataMs",
  "siteConfigMs",
] as const satisfies readonly (keyof RendererTimingReport)[];

/** Returns the response without the timing header, and the parsed report. */
export function takeRendererTiming(response: Response): {
  response: Response;
  report: RendererTimingReport | undefined;
} {
  const raw = response.headers.get(RENDERER_TIMING_HEADER);
  if (raw === null) return { response, report: undefined };
  const headers = new Headers(response.headers);
  headers.delete(RENDERER_TIMING_HEADER);
  return {
    response: new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    report: parseRendererTimingReport(raw),
  };
}

export function parseRendererTimingReport(
  raw: string,
): RendererTimingReport | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const fields: Record<string, unknown> = { ...value };
  if (typeof fields.isolateId !== "string") return undefined;
  if (!REQUIRED_NUMBER_FIELDS.every((field) => isFiniteNumber(fields[field]))) {
    return undefined;
  }
  if (
    !OPTIONAL_NUMBER_FIELDS.every(
      (field) => fields[field] === undefined || isFiniteNumber(fields[field]),
    )
  ) {
    return undefined;
  }
  return {
    isolateId: fields.isolateId,
    isolateRequests: Number(fields.isolateRequests),
    isolateAgeMs: Number(fields.isolateAgeMs),
    requestStartedAt: Number(fields.requestStartedAt),
    ...(isFiniteNumber(fields.routeDataMs)
      ? { routeDataMs: fields.routeDataMs }
      : {}),
    ...(isFiniteNumber(fields.siteConfigMs)
      ? { siteConfigMs: fields.siteConfigMs }
      : {}),
    contentCalls: Number(fields.contentCalls),
    contentMs: Number(fields.contentMs),
    longestContentMs: Number(fields.longestContentMs),
    respondedAt: Number(fields.respondedAt),
  };
}

export function toRenderPhases(input: {
  report: RendererTimingReport;
  calledAt: number;
  respondedAt: number;
}): RenderPhases {
  const { report, calledAt, respondedAt } = input;
  return {
    beforeHandlerMs: report.requestStartedAt - calledAt,
    handlerMs: report.respondedAt - report.requestStartedAt,
    afterHandlerMs: respondedAt - report.respondedAt,
    ...(report.routeDataMs !== undefined
      ? { routeDataMs: report.routeDataMs }
      : {}),
    ...(report.siteConfigMs !== undefined
      ? { siteConfigMs: report.siteConfigMs }
      : {}),
    contentCalls: report.contentCalls,
    contentMs: report.contentMs,
    longestContentMs: report.longestContentMs,
  };
}

export function toIsolateFacts(
  report: RendererTimingReport,
): RendererIsolateFacts {
  return {
    isolateId: report.isolateId,
    isolateRequests: report.isolateRequests,
    isolateAgeMs: report.isolateAgeMs,
  };
}

export interface BodyTiming {
  bodyMs: number;
  bytes: number;
}

/**
 * Passes the body through unchanged and reports when the last chunk passed.
 * A body that is never read to the end, such as an aborted visitor request,
 * reports nothing.
 */
export function observeResponseBody(
  response: Response,
  onComplete: (timing: BodyTiming) => void,
): Response {
  const startedAt = Date.now();
  if (!response.body) {
    onComplete({ bodyMs: 0, bytes: 0 });
    return response;
  }
  let bytes = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush() {
      onComplete({ bodyMs: Date.now() - startedAt, bytes });
    },
  });
  return new Response(response.body.pipeThrough(counter), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
