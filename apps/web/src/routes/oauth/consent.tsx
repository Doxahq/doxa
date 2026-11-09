import { createFileRoute, redirect } from "@tanstack/react-router"

import { ConsentPage } from "~/components/oauth/consent-page"
import { OAUTH_PAGE_HEADERS } from "~/lib/oauth/page-headers"
import { hasDashboardSignIn } from "~/server/dashboard-session"

interface ConsentSearch {
  /** The pending consent ID from the API's `/oauth/authorize` redirect. */
  id: string
}

export const Route = createFileRoute("/oauth/consent")({
  validateSearch: (search: Record<string, unknown>): ConsentSearch => ({
    id: typeof search.id === "string" ? search.id : "",
  }),
  headers: () => OAUTH_PAGE_HEADERS,
  loader: async ({ location }) => {
    if (!(await hasDashboardSignIn())) {
      throw redirect({ to: "/login", search: { redirect: location.href } })
    }
  },
  component: ConsentRoute,
})

function ConsentRoute() {
  const { id } = Route.useSearch()
  return <ConsentPage consentId={id} />
}
