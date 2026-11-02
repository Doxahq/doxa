import type { AuthEnv } from "./server";
import { createAuth } from "./server";

export interface AuthenticatedUser {
  id: string;
  email?: string;
  /** True only when the sign-in provider verified `email`. */
  emailVerified: boolean;
  name?: string;
  image?: string | null;
}

export interface GetSessionUserOptions {
  /**
   * Receives the `Set-Cookie` values that keep the session cookie cache fresh.
   * When it is set, a lookup that missed the cookie cache (it is older than
   * its max age) issues a new `session_data` cookie, and the caller forwards
   * it on its response. Then the next requests read the session from the
   * signed cookie instead of the session store.
   *
   * Only cookie cache values come through. A lookup never forwards a cookie
   * that ends the session: the API answers 401 and the web app signs out.
   */
  onSessionCookies?: (setCookies: string[]) => void;
}

export async function getSessionUser(
  env: AuthEnv,
  request: Request,
  options: GetSessionUserOptions = {},
): Promise<AuthenticatedUser | null> {
  const auth = createAuth(env, request);

  if (!options.onSessionCookies) {
    const session = await auth.api.getSession({
      headers: request.headers,
      query: {
        disableRefresh: true,
      },
    });
    return toAuthenticatedUser(session);
  }

  // `deferSessionRefresh` is on (see `createAuth`), so this GET lookup never
  // writes the session store. It only signs a new cookie cache value when the
  // old one has expired. `disableRefresh` would skip that cookie too.
  const { headers, response: session } = await auth.api.getSession({
    headers: request.headers,
    returnHeaders: true,
  });
  const user = toAuthenticatedUser(session);

  if (user) {
    const setCookies = sessionCacheCookies(headers);
    if (setCookies.length > 0) options.onSessionCookies(setCookies);
  }

  return user;
}

function toAuthenticatedUser(
  session: {
    user?: {
      id?: string;
      email?: string;
      emailVerified?: boolean;
      name?: string;
      image?: string | null;
    };
  } | null,
): AuthenticatedUser | null {
  if (!session?.user?.id) return null;

  return {
    id: session.user.id,
    email: session.user.email,
    emailVerified: session.user.emailVerified === true,
    name: session.user.name,
    image: session.user.image,
  };
}

/**
 * The `Set-Cookie` values of the session cookie cache (`session_data`, also
 * when Better Auth splits it into `session_data.0`, `.1`, ...). A value that
 * clears the cookie is left out.
 */
export function sessionCacheCookies(headers: Headers | null | undefined): string[] {
  if (!headers) return [];

  return headers.getSetCookie().filter((value) => {
    const [pair = ""] = value.split(";", 1);
    const separator = pair.indexOf("=");
    if (separator <= 0) return false;
    const name = pair.slice(0, separator).trim();
    const cookieValue = pair.slice(separator + 1).trim();
    return SESSION_CACHE_COOKIE.test(name) && cookieValue !== "" && !clearsCookie(value);
  });
}

const SESSION_CACHE_COOKIE = /(?:^|[.\-_])session_data(?:\.\d+)?$/;

function clearsCookie(setCookie: string): boolean {
  return /;\s*max-age=(?:0|-\d+)\s*(?:;|$)/i.test(setCookie);
}
