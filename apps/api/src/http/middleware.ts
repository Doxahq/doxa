import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { MiddlewareHandler } from "hono";
import type { ApiBindings } from "./app";
import { enforceMutationCsrf } from "./csrf";

const CORS_ALLOW_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const CORS_ALLOW_HEADERS = ["content-type", "authorization", "x-doxa-user-id"];
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

export function isAllowedCorsOrigin(origin: string, allowedOrigin: string | undefined): boolean {
  if (!origin) return false;
  return !allowedOrigin || origin === allowedOrigin;
}
