import type { DashboardSession, DashboardSessionUser } from "~/lib/auth/dashboard-session"
import { hasSessionTokenCookie, hasSignedInCookie, readSessionCookieIdentity } from "~/lib/auth/session-cookie"

/**
 * What the dashboard shell needs before it renders. Null means the request has
 * no session cookie, so the person goes to the login page.
 */
export interface DashboardEntry {
  /** The local development user from `VITE_DEV_USER_ID`, else null: the browser asks for the session. */
  devSession: DashboardSession | null
  /**
   * The person named by the session cache cookie, so the server render shows
   * their email. FOR DISPLAY ONLY: it is not verified (see
   * `readSessionCookieIdentity`). Null when the cookie is missing or expired.
   */
  identityHint: DashboardSessionUser | null
}

/** The dashboard entry for a request's cookies. It makes no request. */
export function resolveDashboardEntry(
  cookieHeader: string | null | undefined,
  devSession: DashboardSession | null,
  now: number = Date.now(),
): DashboardEntry | null {
  if (devSession) return { devSession, identityHint: null }
  // The marker, or a session cookie from before host-only cookies (SEC-021).
  if (!hasSignedInCookie(cookieHeader) && !hasSessionTokenCookie(cookieHeader)) return null
  const identity = readSessionCookieIdentity(cookieHeader, now)
  return {
    devSession: null,
    // The same fields as the session from the browser (see `toAuthSessionUser`).
    identityHint: identity ? { id: identity.id, email: identity.email, name: null, image: null } : null,
  }
}
