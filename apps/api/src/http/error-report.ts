import type { ApiContext } from "./app";
import { toSafeErrorLog } from "./error-log";
import { requestState } from "./request-state";
import { productAnalyticsOf } from "../services/analytics/product-analytics";

/** posthog-js `tracing_headers` sends it, so the error links to the session replay. */
const POSTHOG_SESSION_HEADER = "x-posthog-session-id";

const REPORTED_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
type ReportedMethod = (typeof REPORTED_METHODS)[number];

/**
 * Reports an unexpected error that the API answers with a 5xx to product
 * analytics. It never looks up the session: it uses the session user only
 * when this request has already read it.
 */
export async function reportServerError(context: ApiContext, cause: unknown, status: number): Promise<void> {
  try {
    const userId = await resolvedSessionUserId(context);
    const sessionId = context.req.header(POSTHOG_SESSION_HEADER);
    const method = reportedMethod(context.req.method);
    productAnalyticsOf(context.env).captureException(reportableError(cause), {
      ...(userId ? { distinctId: userId } : {}),
      ...(sessionId ? { sessionId } : {}),
      properties: { route: context.req.routePath, status, ...(method ? { method } : {}) },
    });
  } catch {
    // The error answer must go out even when the report fails.
  }
}

async function resolvedSessionUserId(context: ApiContext): Promise<string | undefined> {
  const pending = requestState(context.req.raw, context.env).sessionUser;
  if (!pending) return undefined;
  const user = await pending.catch(() => null);
  return user?.id;
}

function reportedMethod(method: string): ReportedMethod | undefined {
  return REPORTED_METHODS.find((candidate) => candidate === method);
}

/**
 * The error without its message: a message can quote customer content, such
 * as a repository name or a file path, and only the logs keep it. The name,
 * the database error code and the stack frames group and locate the error.
 */
function reportableError(cause: unknown): Error {
  const safe = toSafeErrorLog(cause);
  const summary = safe.code ? `${safe.name} (${safe.code})` : safe.name;
  const reported = new Error(summary);
  reported.name = safe.name;
  reported.stack = safe.stack ? `${safe.name}: ${summary}\n${safe.stack}` : `${safe.name}: ${summary}`;
  return reported;
}
