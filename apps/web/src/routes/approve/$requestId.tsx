import { createFileRoute, redirect } from "@tanstack/react-router"

import { ApprovalLinkPage } from "~/components/approvals/approval-link-page"
import { hasDashboardSignIn } from "~/server/dashboard-session"

/** Approval links lead to decisions, so no site may frame them. */
const APPROVAL_LINK_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
}

export const Route = createFileRoute("/approve/$requestId")({
  headers: () => APPROVAL_LINK_HEADERS,
  loader: async ({ location }) => {
    if (!(await hasDashboardSignIn())) {
      throw redirect({ to: "/login", search: { redirect: location.href } })
    }
  },
  component: ApprovalLinkRoute,
})

function ApprovalLinkRoute() {
  const { requestId } = Route.useParams()
  return <ApprovalLinkPage requestId={requestId} />
}
