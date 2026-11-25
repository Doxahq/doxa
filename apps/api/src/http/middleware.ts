import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { MiddlewareHandler } from "hono";
import type { ApiBindings } from "./app";
import { enforceMutationCsrf } from "./csrf";

const CORS_ALLOW_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
// posthog-js `tracing_headers` adds all three PostHog IDs to dashboard calls,
// so an API error links to the person's session replay. A missing one fails
// the preflight of every dashboard call.
const CORS_ALLOW_HEADERS = [
  "content-type",
  "authorization",
  "x-doxa-user-id",
  "x-posthog-distinct-id",
  "x-posthog-session-id",
  "x-posthog-window-id",
];
const CORS_MAX_AGE_SECONDS = 86_400;

export function securityHeaders(): MiddlewareHandler<ApiBindings> {
  return secureHeaders();
}

export function corsPolicy(): MiddlewareHandler<ApiBindings> {
  return async (context, next) => {
    const requestOrigin = context.req.header("origin") ?? "";
    const allowedOrigin = isAllowedCorsOrigin(requestOrigin, context.env.WEB_ORIGIN)
      ? requestOrigin
      : "";

    const middleware = cors({
      origin: allowedOrigin,
      allowMethods: CORS_ALLOW_METHODS,
      allowHeaders: CORS_ALLOW_HEADERS,
      maxAge: CORS_MAX_AGE_SECONDS,
      credentials: Boolean(allowedOrigin),
    });

    return middleware(context, next);
  };
}

export function csrfProtection(): MiddlewareHandler<ApiBindings> {
  return async (context, next) => {
    const csrfError = enforceMutationCsrf(context.req.raw, context.env, context.req.path);
    if (csrfError) return csrfError;

    await next();
  };
}

/**
 * Only the dashboard origin may call with credentials. Without WEB_ORIGIN no
 * origin is allowed (SEC-020): the check must fail closed, never open.
 */
export function isAllowedCorsOrigin(origin: string, allowedOrigin: string | undefined): boolean {
  const allowed = allowedOrigin?.trim().replace(/\/+$/, "");
  if (!origin || !allowed) return false;
  return origin === allowed;
}
