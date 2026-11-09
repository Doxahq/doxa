import { createFileRoute } from "@tanstack/react-router"

import { ClaimPage } from "~/components/oauth/claim-page"
import { OAUTH_PAGE_HEADERS } from "~/lib/oauth/page-headers"
import { hasDashboardSignIn } from "~/server/dashboard-session"

interface ClaimSearch {
  /** The link token from `POST /agent/identity`. */
  attempt: string
}

export const Route = createFileRoute("/oauth/claim")({
  validateSearch: (search: Record<string, unknown>): ClaimSearch => ({
    attempt: typeof search.attempt === "string" ? search.attempt : "",
  }),
  headers: () => OAUTH_PAGE_HEADERS,
  loader: async () => ({ signedIn: await hasDashboardSignIn() }),
  component: ClaimRoute,
})

function ClaimRoute() {
  const { attempt } = Route.useSearch()
  const { signedIn } = Route.useLoaderData()
  return <ClaimPage attemptToken={attempt} signedIn={signedIn} />
}
