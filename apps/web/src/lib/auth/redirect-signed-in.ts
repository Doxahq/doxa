import { redirect } from "@tanstack/react-router"

import { sanitizeRedirectPath } from "~/lib/auth/safe-redirect"
import { hasSignedInMarker } from "~/server/dashboard-session"

/**
 * `beforeLoad` of the sign-in and sign-up pages: a signed-in person goes on to
 * `redirectTarget`. The check runs on the server for a direct visit (these
 * routes are not prerendered), so the page never waits for a session in the
 * browser. It reads the API's signed-in marker (SEC-021). A stale marker sends
 * the person on once: the first API call answers 401, clears the marker, and
 * the dashboard comes back here. It is a full page load, so the target page sends its own headers
 * (the consent page forbids framing) instead of rendering inside this document.
 */
export async function redirectIfSignedIn(redirectTarget: string | undefined): Promise<void> {
  if (await hasSignedInMarker()) {
    throw redirect({ href: sanitizeRedirectPath(redirectTarget), reloadDocument: true })
  }
}
