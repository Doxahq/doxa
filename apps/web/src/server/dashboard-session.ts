import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"

import { createDevDashboardSession } from "~/lib/auth/dashboard-session"
import { resolveDashboardEntry, type DashboardEntry } from "~/lib/auth/dashboard-entry"
import { hasSignedInCookie } from "~/lib/auth/session-cookie"

const DEV_USER_ID = import.meta.env.VITE_DEV_USER_ID

export type { DashboardEntry }

/**
 * The dashboard's entry check. It reads only the request cookies, so the
 * shell HTML does not wait for the API. The API still checks the session on
 * every request, and the shell sends a person with an unknown session to the
 * login page (see `DashboardAuthProvider`).
 */
export const getDashboardEntry = createServerFn({ method: "GET" }).handler(
  async (): Promise<DashboardEntry | null> => {
    const devSession = DEV_USER_ID ? createDevDashboardSession(DEV_USER_ID) : null
    return resolveDashboardEntry(devSession ? null : getRequest().headers.get("cookie"), devSession)
  },
)

/**
 * True when the request looks signed in: the API's signed-in marker or a
 * session cookie. The session cookies are host-only on the API host
 * (SEC-021), so the dashboard server cannot ask the API who is signed in. The
 * page confirms the session in the browser, where every API call checks it,
 * and a stale marker is cleared by the first 401.
 */
export const hasDashboardSignIn = createServerFn({ method: "GET" }).handler(
  async (): Promise<boolean> => {
    if (DEV_USER_ID) return true
    return resolveDashboardEntry(getRequest().headers.get("cookie"), null) !== null
  },
)

/**
 * The login page's check: the marker only. A session cookie from before the
 * host-only change can hold a revoked session, and /login would then send the
 * person to a dashboard that sends them back (a loop). The API clears a stale
 * marker on the first 401 or empty session read, so this cannot loop.
 */
export const hasSignedInMarker = createServerFn({ method: "GET" }).handler(
  async (): Promise<boolean> => {
    if (DEV_USER_ID) return true
    return hasSignedInCookie(getRequest().headers.get("cookie"))
  },
)
