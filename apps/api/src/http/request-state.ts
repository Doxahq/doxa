import type { AuthenticatedUser } from "@doxahq/auth";
import type { Env } from "../env";
import type { MeasureStep } from "../services/request-timing";
import type { ApiContext } from "./app";
import type { ProjectAccessStore } from "../services/agent-access/membership-project-access-policy";
import { createApiServerTiming, type ApiServerTiming } from "./server-timing";

/**
 * What one API request remembers while it runs: the session user, the
 * project access store, the timings, and the cookies that the session
 * lookup asks the response to set.
 *
 * The state belongs to the incoming `Request` object, so every Hono
 * sub-router of one request sees the same state and two requests never share
 * it. Nothing here outlives the request.
 */
export interface RequestState {
  readonly timing: ApiServerTiming;
  /** `Set-Cookie` values for the response, from the session lookup. */
  readonly setCookies: string[];
  sessionUser?: Promise<AuthenticatedUser | null>;
  accessStore?: ProjectAccessStore;
}

const states = new WeakMap<Request, RequestState>();

/** The state of `request`. The first call creates it. */
export function requestState(
  request: Request,
  env: Pick<Env, "DEBUG"> | undefined,
): RequestState {
  let state = states.get(request);

  if (!state) {
    state = { timing: createApiServerTiming(env?.DEBUG), setCookies: [] };
    states.set(request, state);
  }

  return state;
}

/**
 * What a request-scoped service needs from the request: the timing, while
 * it records, and `waitUntil` for work that may finish after the response.
 */
export function serviceRequestOptions(context: ApiContext): {
  measure?: MeasureStep;
  waitUntil?: (promise: Promise<unknown>) => void;
} {
  const { timing } = requestState(context.req.raw, context.env);
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    const executionContext = context.executionCtx;
    waitUntil = (promise) => executionContext.waitUntil(promise);
  } catch {
    // Tests run the router without an execution context.
  }

  return {
    ...(timing.recording
      ? { measure: (name, step) => timing.measure(name, step) }
      : {}),
    ...(waitUntil ? { waitUntil } : {}),
  };
}
