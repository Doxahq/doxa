import type { Env } from "../env";

/**
 * The "signed in" marker of the dashboard (SEC-021).
 *
 * The session cookies are host-only on the API host, so the doxa.so server
 * render cannot see them. It reads this marker instead, to decide whether to
 * show the dashboard shell or the login page. The marker holds no secret and
 * grants nothing: every API request still checks the real session.
 *
 * The API keeps it in step with the session: it is set when Better Auth sets
 * a session token, or when a request has a session but no marker, and it is
 * cleared when Better Auth clears the token or a request has a marker but no
 * session.
 */
const SIGNED_IN_SUFFIX = ".signed_in";
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const SESSION_TOKEN_COOKIE = /^(?:__Secure-|__Host-)?[^\s=;]+\.session_token=([^;]*)/i;

type SignedInEnv = Pick<Env, "AUTH_COOKIE_PREFIX" | "WEB_ORIGIN">;

export function signedInCookieName(env: SignedInEnv): string {
  return `${env.AUTH_COOKIE_PREFIX?.trim() || "doxa"}${SIGNED_IN_SUFFIX}`;
}

export function hasSignedInCookie(request: Request, env: SignedInEnv): boolean {
  const name = signedInCookieName(env);
  return (request.headers.get("cookie") ?? "")
    .split(";")
    .some((pair) => pair.trim() === `${name}=1`);
}

/** The Set-Cookie value that sets (true) or clears (false) the marker. */
export function signedInCookie(env: SignedInEnv, signedIn: boolean): string {
  const web = webOrigin(env);
  const attributes = [
    `${signedInCookieName(env)}=${signedIn ? "1" : ""}`,
    "Path=/",
    `Max-Age=${signedIn ? MAX_AGE_SECONDS : 0}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  // The dashboard host, so doxa.so receives a marker that api.doxa.so sets.
  // A loopback host takes a host-only cookie, which every local port shares.
  if (web && !isLoopback(web.hostname)) attributes.push(`Domain=${web.hostname}`);
  if (web?.protocol === "https:") attributes.push("Secure");
  return attributes.join("; ");
}

/**
 * The marker change that a Better Auth response needs: set when it sets a
 * session token, clear when it clears one, else null.
 */
export function signedInChangeFor(response: Response): boolean | null {
  for (const setCookie of response.headers.getSetCookie()) {
    const match = SESSION_TOKEN_COOKIE.exec(setCookie);
    if (!match) continue;
    const cleared = match[1] === "" || /;\s*max-age=0\b/i.test(setCookie);
    return !cleared;
  }
  return null;
}

type SyncEnv = SignedInEnv & Pick<Env, "AUTH_COOKIE_DOMAIN">;

const BETTER_AUTH_COOKIE = /^((?:__Secure-|__Host-)?[^\s=;]+\.(?:session_token|session_data|dont_remember))=/i;

/**
 * The Better Auth response with the marker change it needs.
 *
 * - A session token set or cleared sets or clears the marker.
 * - A session read that finds no session clears a marker that the request
 *   still carries, so a stale marker cannot send /login to the dashboard.
 * - With host-only session cookies, a cleared cookie is also cleared on the
 *   dashboard domain: a cookie from before the change (Domain=.doxa.so) must
 *   not outlive a sign-out.
 */
export async function withSignedInCookieSync(
  request: Request,
  response: Response,
  env: SyncEnv,
): Promise<Response> {
  const setCookies: string[] = [];
  const change = signedInChangeFor(response);
  if (change !== null) setCookies.push(signedInCookie(env, change));
  if (change === false) setCookies.push(...legacyDomainClears(response, env));
  if (change === null && (await isEmptySessionRead(request, response)) && hasSignedInCookie(request, env)) {
    setCookies.push(signedInCookie(env, false));
  }
  if (setCookies.length === 0) return response;

  const result = new Response(response.body, response);
  for (const setCookie of setCookies) result.headers.append("set-cookie", setCookie);
  return result;
}

/** GET /api/auth/get-session answered with no session (JSON null). */
async function isEmptySessionRead(request: Request, response: Response): Promise<boolean> {
  if (request.method !== "GET" || !new URL(request.url).pathname.endsWith("/get-session")) return false;
  if (!response.ok) return false;
  return (await response.clone().text()).trim() === "null";
}

function legacyDomainClears(response: Response, env: SyncEnv): string[] {
  const web = webOrigin(env);
  if (env.AUTH_COOKIE_DOMAIN?.trim() || !web || isLoopback(web.hostname)) return [];
  const secure = web.protocol === "https:" ? "; Secure" : "";
  return response.headers.getSetCookie().flatMap((setCookie) => {
    const name = BETTER_AUTH_COOKIE.exec(setCookie)?.[1];
    const cleared = /^[^=]+=;/.test(setCookie) || /;\s*max-age=0\b/i.test(setCookie);
    if (!name || !cleared) return [];
    return [`${name}=; Path=/; Max-Age=0; Domain=${web.hostname}; HttpOnly; SameSite=Lax${secure}`];
  });
}

function webOrigin(env: SignedInEnv): URL | null {
  try {
    return env.WEB_ORIGIN ? new URL(env.WEB_ORIGIN) : null;
  } catch {
    return null;
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
