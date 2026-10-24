import { createFileRoute, redirect } from "@tanstack/react-router"

import { ConsentPage } from "~/components/oauth/consent-page"
import { getDashboardSession } from "~/server/dashboard-session"

interface ConsentSearch {
  /** The pending consent ID from the API's `/oauth/authorize` redirect. */
  id: string
}

/** No site may frame the consent page, so a click on "Allow" is always the person's own. */
const CONSENT_PAGE_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
}

export const Route = createFileRoute("/oauth/consent")({
  validateSearch: (search: Record<string, unknown>): ConsentSearch => ({
    id: typeof search.id === "string" ? search.id : "",
  }),
  headers: () => CONSENT_PAGE_HEADERS,
  loader: async ({ location }) => {
    const session = await getDashboardSession()
    if (!session) {
      throw redirect({ to: "/login", search: { redirect: location.href } })
    }
  },
  component: ConsentRoute,
})

function ConsentRoute() {
  const { id } = Route.useSearch()
  return <ConsentPage consentId={id} />
}
