import { createFileRoute } from "@tanstack/react-router"

import { ResetPasswordPage } from "~/components/auth/reset-password-page"

interface ResetPasswordSearch {
  /** The reset token, added by the API when the reset link is valid. */
  token?: string
  /** `INVALID_TOKEN` when the link was used or expired. */
  error?: string
}

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): ResetPasswordSearch => ({
    ...(typeof search.token === "string" ? { token: search.token } : {}),
    ...(typeof search.error === "string" ? { error: search.error } : {}),
  }),
  component: ResetPasswordRoute,
})

function ResetPasswordRoute() {
  const { token, error } = Route.useSearch()
  return <ResetPasswordPage token={token ?? null} linkError={Boolean(error)} />
}
