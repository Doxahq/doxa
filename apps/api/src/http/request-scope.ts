import { createRequestDbScope, type RequestDbScopeOptions } from "@doxahq/db";
import type { Env } from "../env";
import { isAllowedCorsOrigin } from "./middleware";
import { requestState, type RequestState } from "./request-state";

type FetchHandler = (
  request: Request,
  env: Env,
  context: ExecutionContext,
) => Response | Promise<Response>;

/**
 * The Worker `fetch`. The env is typed loosely, as Hono's `app.fetch` does,
 * so tests can pass only the bindings they use.
 */
export type ScopedFetch = (
  request: Request,
  env: object,
  context: ExecutionContext,
) => Promise<Response>;

export interface RequestScopeOptions extends RequestDbScopeOptions {
  now?: () => number;
}

/**
 * Runs each request on one database scope: every `createDb(env)` of the
 * request shares one pool, so a request opens one connection per kind
 * instead of one pool per repository.
 *
 * The scope closes only when the request has nothing left to do:
 *
 * - the handler returned its response;
 * - every promise passed to `waitUntil` has settled, also the ones that
 *   such work starts later (a webhook, an approval email, a publish that
 *   keeps running after a disconnect);
 * - an event stream (`text/event-stream`) has ended or the client left.
 *
 * The close itself runs in `waitUntil`, after the response.
 *
 * It also adds the per-request response headers: the session cookie cache
 * value and, for admins or with `DEBUG`, Server-Timing.
 */
export function withRequestScope(
  handler: FetchHandler,
  options: RequestScopeOptions = {},
): ScopedFetch {
  const now = options.now ?? (() => performance.now());

  return async (request, workerEnv, executionContext) => {
    const env = workerEnv as Env;
    const startedAt = now();
    const state = requestState(request, env);
    const scope = createRequestDbScope(env, options);
    const work = trackWork(executionContext);
    const closeScope = () => {
      executionContext.waitUntil(
        work
          .settled()
          .then(() => scope.close())
          .catch((cause: unknown) => {
            console.error("The request database scope did not close.", cause);
          }),
      );
    };

    let response: Response;
    try {
      response = await handler(request, scope.env, work.context);
    } catch (cause) {
      closeScope();
      throw cause;
    }

    response = finishResponse(response, request, env, state, now() - startedAt);
    if (isEventStream(response) && response.body) {
      const ended = observeBodyEnd(response.body);
      work.track(ended.done);
      response = new Response(ended.body, response);
    }
    closeScope();
    return response;
  };
}

/**
 * An execution context that remembers each `waitUntil` promise, so the
 * scope can wait for them.
 */
function trackWork(executionContext: ExecutionContext) {
  const pending = new Set<Promise<unknown>>();
  const track = (promise: Promise<unknown>) => {
    const settled = promise.then(
      () => undefined,
      () => undefined,
    );
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
  };

  const context: ExecutionContext = {
    waitUntil(promise) {
      track(promise);
      executionContext.waitUntil(promise);
    },
    passThroughOnException() {
      executionContext.passThroughOnException();
    },
    get props() {
      return executionContext.props;
    },
    // The OAuth provider sets `props` for the handler it calls.
    set props(value) {
      (executionContext as { props: unknown }).props = value;
    },
  } as ExecutionContext;

  return {
    context,
    track,
    /** Resolves when no tracked work is left, also work added meanwhile. */
    async settled(): Promise<void> {
      while (pending.size > 0) {
        await Promise.all(pending);
      }
    },
  };
}

function isEventStream(response: Response): boolean {
  return (
    response.headers.get("content-type")?.startsWith("text/event-stream") ??
    false
  );
}

/** Passes a body through and resolves when it ends, fails, or is cancelled. */
function observeBodyEnd(body: ReadableStream<Uint8Array>) {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const done = body.pipeTo(writable).then(
    () => undefined,
    () => undefined,
  );
  return { body: readable, done };
}

function finishResponse(
  response: Response,
  request: Request,
  env: Env,
  state: RequestState,
  totalMs: number,
): Response {
  const timing = state.timing;
  const serverTiming = timing.allowed
    ? (timing.add("total", totalMs), timing.headerValue())
    : null;

  if (state.setCookies.length === 0 && !serverTiming) {
    return response;
  }

  // A new response, because the headers of some responses are immutable.
  const result = new Response(response.body, response);
  for (const setCookie of state.setCookies) {
    result.headers.append("set-cookie", setCookie);
  }

  if (serverTiming) {
    result.headers.append("server-timing", serverTiming);
    const origin = request.headers.get("origin") ?? "";
    if (isAllowedCorsOrigin(origin, env.WEB_ORIGIN)) {
      // The dashboard runs on another origin. Without these headers the
      // browser hides the timings from DevTools and from scripts.
      result.headers.set("timing-allow-origin", origin);
      result.headers.append("access-control-expose-headers", "Server-Timing");
    }
  }

  return result;
}
