import { currentUserResponseSchema } from "@doxahq/contracts"
import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"

import {
  createDashboardSession,
  createDevDashboardSession,
  type DashboardSession,
} from "~/lib/auth/dashboard-session"
import { resolveDashboardEntry, type DashboardEntry } from "~/lib/auth/dashboard-entry"
import { getApiUrl } from "~/lib/platform-api"

const DEV_USER_ID = import.meta.env.VITE_DEV_USER_ID
const DASHBOARD_SESSION_TIMEOUT_MS = 5_000
const DASHBOARD_SESSION_SLOW_THRESHOLD_MS = 2_000

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

export const getDashboardSession = createServerFn({ method: "GET" }).handler(
  async (): Promise<DashboardSession | null> => {
    if (DEV_USER_ID) {
      return createDevDashboardSession(DEV_USER_ID)
    }

    const startedAt = Date.now()

    try {
      const request = getRequest()
      const response = await fetch(getApiUrl("/me"), {
        headers: forwardedAuthHeaders(request.headers),
        signal: AbortSignal.timeout(DASHBOARD_SESSION_TIMEOUT_MS),
      })

      if (response.status === 401) return null

      if (!response.ok) {
        console.error("Dashboard session probe failed.", {
          status: response.status,
          body: await response.text().catch(() => null),
        })
        return null
      }

      const payload = await response.json()
      const parsed = currentUserResponseSchema.safeParse(payload)

      if (!parsed.success) {
        console.error("Dashboard session response did not match the expected shape.", {
          issues: parsed.error.issues,
        })
        return null
      }

      return createDashboardSession(parsed.data.user)
    } catch (error) {
      const durationMs = Date.now() - startedAt
      const timedOut = isNamedError(error, "TimeoutError")

      if (timedOut) {
        console.error(`Dashboard session probe timed out after ${durationMs}ms.`)
      } else {
        console.error("Dashboard session probe failed before receiving a response.", error)
      }
      return null
    } finally {
      const durationMs = Date.now() - startedAt
      if (durationMs >= DASHBOARD_SESSION_SLOW_THRESHOLD_MS && durationMs < DASHBOARD_SESSION_TIMEOUT_MS) {
        console.warn(`Dashboard session probe was slow (${durationMs}ms).`)
      }
    }
  },
)

function forwardedAuthHeaders(requestHeaders: Headers): Headers {
  const headers = new Headers({ accept: "application/json" })
  copyHeader(requestHeaders, headers, "cookie")
  copyHeader(requestHeaders, headers, "authorization")
  return headers
}

function copyHeader(source: Headers, target: Headers, name: string): void {
  const value = source.get(name)
  if (value) {
    target.set(name, value)
  }
}

function isNamedError(error: unknown, name: string): boolean {
  return typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === name
}
