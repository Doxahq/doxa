import { createFileRoute } from "@tanstack/react-router"

import { LoginPage } from "~/components/auth/login-page"
import { loginErrorMessage } from "~/lib/auth/email-password"
import { redirectIfSignedIn } from "~/lib/auth/redirect-signed-in"
import { sanitizeRedirectPath } from "~/lib/auth/safe-redirect"

interface LoginSearch {
  /** Where to go after sign-in. The page sanitizes it before use. */
  redirect?: string
  /** Set by the API when a sign-in or a verification link fails. */
  error?: string
  /** Set by another auth page, such as after a password reset. */
  notice?: "password-reset"
}

const NOTICES: Record<NonNullable<LoginSearch["notice"]>, string> = {
  "password-reset": "Your password changed. Sign in with the new one.",
}

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Sign in — Doxa" }] }),
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    ...(typeof search.redirect === "string" ? { redirect: search.redirect } : {}),
    ...(typeof search.error === "string" ? { error: search.error } : {}),
    ...(search.notice === "password-reset" ? { notice: search.notice } : {}),
  }),
  beforeLoad: ({ search }) => redirectIfSignedIn(search.redirect),
  component: LoginRoute,
})

function LoginRoute() {
  const { redirect: redirectTarget, error, notice } = Route.useSearch()

  return (
    <LoginPage
      redirectPath={sanitizeRedirectPath(redirectTarget)}
      errorMessage={loginErrorMessage(error)}
      notice={notice ? NOTICES[notice] : null}
    />
  )
}
