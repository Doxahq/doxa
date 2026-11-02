import { createFileRoute, redirect } from "@tanstack/react-router"

import { LoginPage } from "~/components/auth/login-page"
import { sanitizeRedirectPath } from "~/lib/auth/safe-redirect"
import { SIGN_IN_UNAVAILABLE_ERROR } from "~/lib/auth/sign-in-link"
import { hasSignedInMarker } from "~/server/dashboard-session"

interface LoginSearch {
  /** Where to go after sign-in. The page sanitizes it before use. */
  redirect?: string
  /** Set by the API when it cannot start a sign-in. */
  error?: string
}

const SIGN_IN_UNAVAILABLE_MESSAGE = "Sign-in is not available right now. Try again later or use another option."

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    ...(typeof search.redirect === "string" ? { redirect: search.redirect } : {}),
    ...(typeof search.error === "string" ? { error: search.error } : {}),
  }),
  // The sign-in check runs on the server for a direct visit (this route is not
  // prerendered), so the page never waits for a session in the browser. It
  // reads the API's signed-in marker (SEC-021). A stale marker sends the
  // person on once; the first API call answers 401, clears the marker, and
  // the dashboard comes back here.
  beforeLoad: async ({ search }) => {
    if (await hasSignedInMarker()) {
      // A full page load, so the target page sends its own headers (the
      // consent page forbids framing) instead of rendering inside this document.
      throw redirect({ href: sanitizeRedirectPath(search.redirect), reloadDocument: true })
    }
  },
  component: LoginRoute,
})

function LoginRoute() {
  const { redirect: redirectTarget, error } = Route.useSearch()

  return (
    <LoginPage
      redirectPath={sanitizeRedirectPath(redirectTarget)}
      errorMessage={error === SIGN_IN_UNAVAILABLE_ERROR ? SIGN_IN_UNAVAILABLE_MESSAGE : null}
    />
  )
}
