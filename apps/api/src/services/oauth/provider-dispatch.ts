import type { MiddlewareHandler } from "hono";
import type { ApiBindings } from "../../http/app";
import { toSafeErrorLog } from "../../http/error-log";
import { limitRequestBody, RequestBodyTooLarge } from "../../http/bounded-body";
import { error } from "../../http/response";
import { authorizationServerFor, isOAuthProviderPath } from "./authorization-server";
import { OAuthNotConfiguredError, resolveOAuthConfig, type OAuthSettings } from "./oauth-config";

/** Token, registration and revocation requests are small. */
const OAUTH_BODY_MAX_BYTES = 1024 * 1024;

/** Hands provider paths to the provider before any other middleware runs. */
export function oauthProviderDispatch(): MiddlewareHandler<ApiBindings> {
  return async (context, next) => {
    if (!isOAuthProviderPath(context.req.path)) return next();
    let request: Request;
    try {
      request = limitRequestBody(context.req.raw, OAUTH_BODY_MAX_BYTES);
    } catch (cause) {
      if (cause instanceof RequestBodyTooLarge) return error("Request body is too large.", 413);
      throw cause;
    }
    return serveOAuthProviderRequest(request, context.env, context.executionCtx);
  };
}

/**
 * Provider failures are caught here so they get the same safe 500 contract
 * as Hono routes, without the provider's error text.
 */
export async function serveOAuthProviderRequest(
  request: Request,
  env: OAuthSettings,
  ctx: ExecutionContext,
): Promise<Response> {
  const resolution = resolveOAuthConfig(env);
  if (!resolution.configured) {
    return oauthNotConfiguredResponse(new OAuthNotConfiguredError(resolution.missing));
  }
  try {
    return await authorizationServerFor(resolution.config).fetch(request, resolution.env, ctx);
  } catch (cause) {
    console.error("OAuth provider request failed.", toSafeErrorLog(cause));
    return error("Internal server error.", 500);
  }
}

export function oauthNotConfiguredResponse(cause: OAuthNotConfiguredError): Response {
  console.error("OAuth request on a deployment without OAuth config.", {
    missing: cause.missing,
  });
  return error("Agent access is not available on this deployment.", 503);
}
