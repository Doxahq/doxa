import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import type { ApiContext } from "./app";

export type ProgressEvent<TStage, TResult> =
  | { readonly type: "stage"; readonly stage: TStage }
  | { readonly type: "result"; readonly result: TResult }
  | { readonly type: "error"; readonly status: number; readonly body: unknown };

export function acceptsEventStream(request: Request): boolean {
  return request.headers.get("accept")?.includes("text/event-stream") ?? false;
}

/**
 * Sends each stage as a server-sent event, then one `result` or `error`
 * event. The work runs to its end even if the client disconnects.
 */
export function streamProgress<TStage, TResult>(
  context: ApiContext,
  work: (onStage: (stage: TStage) => void) => Promise<TResult>,
  toErrorResponse: (cause: unknown) => Response | Promise<Response>,
): Response {
  const response = streamEvents(context, async (stream) => {
    // Writes stay in call order. A write after a disconnect does nothing.
    let writes = Promise.resolve();
    const send = (event: ProgressEvent<TStage, TResult>) => {
      writes = writes.then(() =>
        stream.writeSSE({ event: event.type, data: JSON.stringify(event) }),
      );
      return writes;
    };
    const outcome = work((stage) => void send({ type: "stage", stage }))
      .then((result): ProgressEvent<TStage, TResult> => ({ type: "result", result }))
      .catch(async (cause: unknown): Promise<ProgressEvent<TStage, TResult>> => {
        const failure = await toErrorResponse(cause);
        return { type: "error", status: failure.status, body: await failure.json() };
      });

    keepRunning(context, outcome);
    await send(await outcome);
  });

  return asEventStreamResponse(context, response);
}

/** The headers that keep a stream unbuffered and uncached through the edge. */
export function asEventStreamResponse(context: ApiContext, response: Response): Response {
  context.res = response;
  context.header("Cache-Control", "no-store, no-transform");
  context.header("Content-Encoding", "Identity");
  context.header("X-Accel-Buffering", "no");
  return context.res;
}

/**
 * `streamSSE`, and the request keeps running until the callback ends, also
 * after the client leaves. The request database scope waits for it, so the
 * callback never queries a closed pool.
 */
export function streamEvents(
  context: ApiContext,
  callback: (stream: SSEStreamingApi) => Promise<void>,
): Response {
  let finish: () => void = () => undefined;
  keepRunning(context, new Promise<void>((resolve) => (finish = resolve)));
  return streamSSE(context, async (stream) => {
    try {
      await callback(stream);
    } finally {
      finish();
    }
  });
}

export function keepRunning(context: ApiContext, work: Promise<unknown>): void {
  try {
    context.executionCtx.waitUntil(work);
  } catch {
    // Tests run the router without an execution context.
  }
}
