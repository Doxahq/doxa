import { createFileRoute, redirect } from "@tanstack/react-router"

import { TeamInvitePage } from "~/components/teams/team-invite-page"
import { hasDashboardSignIn } from "~/server/dashboard-session"

/** An invite link adds a member, so no site may frame it. */
const INVITE_LINK_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  // The token is a secret: never send it on in a Referer header.
  "Referrer-Policy": "no-referrer",
}

export const Route = createFileRoute("/invite/$token")({
  headers: () => INVITE_LINK_HEADERS,
  loader: async ({ location }) => {
    if (!(await hasDashboardSignIn())) {
      throw redirect({ to: "/login", search: { redirect: location.href } })
    }
  },
  component: TeamInviteRoute,
})

function TeamInviteRoute() {
  const { token } = Route.useParams()
  return <TeamInvitePage token={token} />
}
