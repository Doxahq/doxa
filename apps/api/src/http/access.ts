import type { Env } from "../env";

export function getLocalDevUserId(
  request: Request,
  env: Pick<Env, "LOCAL_DEV_USER_ID">,
): string | null {
  if (!env.LOCAL_DEV_USER_ID) return null;

  const url = new URL(request.url);
  const isLocalRequest = isLocalOrigin(url.origin);
  const headerUserId = request.headers.get("x-doxa-user-id");
  if (headerUserId === env.LOCAL_DEV_USER_ID && isLocalRequest) {
    return env.LOCAL_DEV_USER_ID;
  }

  const isLocalInstallCallback =
    url.pathname.replace(/\/+$/, "") === "/github/install/callback" &&
    url.searchParams.get("installation_id")?.startsWith("local");

  return isLocalInstallCallback && isLocalRequest ? env.LOCAL_DEV_USER_ID : null;
}

export function getWebOrigin(request: Request, env: Pick<Env, "WEB_ORIGIN">): string {
  const requestOrigin = new URL(request.url).origin;
  const configuredOrigin = env.WEB_ORIGIN?.replace(/\/+$/, "");

  if (configuredOrigin && !isLocalOrigin(configuredOrigin)) {
    return configuredOrigin;
  }

  if (!isLocalOrigin(requestOrigin)) {
    return requestOrigin;
  }

  return configuredOrigin || requestOrigin;
}

export function isInternalHttpAllowed(
  request: Request,
  env: Pick<Env, "ALLOW_INTERNAL_HTTP">,
): boolean {
  return env.ALLOW_INTERNAL_HTTP === "true" && isLocalOrigin(new URL(request.url).origin);
}

export function isLocalOrigin(origin: string): boolean {
  const hostname = new URL(origin).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}
