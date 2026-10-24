import { createFileRoute } from "@tanstack/react-router"

import { EmailUnsubscribePage } from "~/components/email/email-unsubscribe-page"

/** The signed query is a secret: never frame the page or send the query on. */
const UNSUBSCRIBE_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
}

export const Route = createFileRoute("/email/unsubscribe")({
  headers: () => UNSUBSCRIBE_HEADERS,
  validateSearch: (search: Record<string, unknown>) => ({
    user: stringParam(search.user),
    category: stringParam(search.category),
    token: stringParam(search.token),
  }),
  component: EmailUnsubscribeRoute,
})

function EmailUnsubscribeRoute() {
  return <EmailUnsubscribePage link={Route.useSearch()} />
}

function stringParam(value: unknown): string {
  return typeof value === "string" ? value : ""
}
