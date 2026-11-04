import { createFileRoute } from "@tanstack/react-router"

import { SignupPage } from "~/components/auth/signup-page"
import { redirectIfSignedIn } from "~/lib/auth/redirect-signed-in"
import { sanitizeRedirectPath } from "~/lib/auth/safe-redirect"

interface SignupSearch {
  /** Where to go after sign-up and verification. The page sanitizes it before use. */
  redirect?: string
}

export const Route = createFileRoute("/signup")({
  validateSearch: (search: Record<string, unknown>): SignupSearch =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
  beforeLoad: ({ search }) => redirectIfSignedIn(search.redirect),
  component: SignupRoute,
})

function SignupRoute() {
  const { redirect: redirectTarget } = Route.useSearch()
  return <SignupPage redirectPath={sanitizeRedirectPath(redirectTarget)} />
}
