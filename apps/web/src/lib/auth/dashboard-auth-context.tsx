import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"

import {
  type DashboardSession,
  type DashboardSessionUser,
} from "~/lib/auth/dashboard-session"
import { signOut } from "~/lib/auth/use-auth-session"
import { authSessionQueryOptions } from "~/lib/queries/auth-session"

interface DashboardAuthValue {
  /** Null while the session loads, and when it could not be loaded. */
  user: DashboardSessionUser | null
  isAuthenticated: true
  /** True until the browser knows who is signed in. */
  isPending: boolean
  signOut: () => Promise<void>
}

const DashboardAuthContext = createContext<DashboardAuthValue | null>(null)

/**
 * The signed-in person for the dashboard shell.
 *
 * The server sends the shell as soon as the request has a session cookie, so
 * the browser loads the identity itself. When the API knows no session for
 * the cookie, the person goes to the login page, as the server redirect did.
 * `devSession` is the local development user (`VITE_DEV_USER_ID`), which needs
 * no request.
 *
 * `identityHint` is the person that the session cache cookie names. The
 * server render and the first browser render show it, so the email does not
 * pop in. It is for display only: the browser session replaces it, and only
 * the browser session decides the redirect to the login page.
 */
export function DashboardAuthProvider({
  children,
  devSession,
  identityHint = null,
}: Readonly<{
  children: ReactNode
  devSession: DashboardSession | null
  identityHint?: DashboardSessionUser | null
}>) {
  const router = useRouter()
  const sessionQuery = useQuery({ ...authSessionQueryOptions(), enabled: devSession === null })
  const isSignedOut = devSession === null && sessionQuery.isSuccess && sessionQuery.data === null

  useEffect(() => {
    if (!isSignedOut) return
    // After sign-in, the person comes back to the page they opened.
    void router.navigate({ to: "/login", search: { redirect: router.state.location.href }, replace: true })
  }, [isSignedOut, router])

  // The browser session wins once it answers. A failed request keeps the hint.
  const user = devSession?.user ?? (sessionQuery.isSuccess ? sessionQuery.data : identityHint)
  const isPending = devSession === null && sessionQuery.isPending && identityHint === null
  const value = useMemo<DashboardAuthValue>(
    () => ({ user, isAuthenticated: true, isPending, signOut }),
    [isPending, user],
  )

  return <DashboardAuthContext.Provider value={value}>{children}</DashboardAuthContext.Provider>
}

export function useDashboardAuth(): DashboardAuthValue {
  const value = useContext(DashboardAuthContext)
  if (!value) {
    throw new Error("useDashboardAuth must be used within DashboardAuthProvider")
  }
  return value
}
