import { Link, useNavigate } from "@tanstack/react-router"
import { Loader2 } from "lucide-react"

import { AuthCard, AuthCardHeading } from "~/components/auth/auth-card"
import { Button } from "~/components/ui/button"
import {
  TEAM_ROLE_DESCRIPTIONS,
  TEAM_ROLE_LABELS,
  formatTeamDate,
  inviteFailureOf,
  inviteFailureView,
} from "~/lib/dashboard/teams-model"
import { useTeamInvite } from "~/lib/dashboard/use-teams"

/**
 * `/invite/<token>`: the page of a team invite link. The user sees the team
 * and the role before joining. A link that no longer works says why.
 */
export function TeamInvitePage({ token }: { token: string }) {
  const navigate = useNavigate()
  const invite = useTeamInvite(token)

  async function accept() {
    try {
      const accepted = await invite.accept()
      void navigate({ to: "/dashboard/teams/$teamId", params: { teamId: accepted.teamId }, replace: true })
    } catch {
      // The card shows the failure.
    }
  }

  if (invite.isLoading) {
    return (
      <AuthCard>
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          Opening the invite…
        </div>
      </AuthCard>
    )
  }

  const failure = invite.acceptError ?? invite.loadError
  if (failure || invite.preview === null) {
    const view = inviteFailureView(failure)
    return (
      <AuthCard>
        <AuthCardHeading title={view.title} description={view.description} />
        <Button variant="outline" asChild className="w-full">
          <Link to={inviteFailureOf(failure) === "already_member" ? "/dashboard/teams" : "/dashboard"}>
            Go to the dashboard
          </Link>
        </Button>
      </AuthCard>
    )
  }

  const { preview } = invite
  if (preview.alreadyMember) {
    return (
      <AuthCard>
        <AuthCardHeading title="Already a member" description={`You are already a member of ${preview.teamName}.`} />
        <Button variant="outline" asChild className="w-full">
          <Link to="/dashboard/teams">Open your teams</Link>
        </Button>
      </AuthCard>
    )
  }

  return (
    <AuthCard>
      <AuthCardHeading title="Join team" description={`You are invited to join ${preview.teamName}.`} />
      <dl className="flex w-full flex-col gap-3 border border-border px-4 py-3.5 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="font-mono text-[11px] tracking-[0.16em] text-label uppercase">Team</dt>
          <dd className="truncate text-foreground">{preview.teamName}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="font-mono text-[11px] tracking-[0.16em] text-label uppercase">Role</dt>
          <dd className="text-foreground">{TEAM_ROLE_LABELS[preview.role]}</dd>
        </div>
        <p className="text-xs text-muted-foreground">{TEAM_ROLE_DESCRIPTIONS[preview.role]}.</p>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="font-mono text-[11px] tracking-[0.16em] text-label uppercase">Expires</dt>
          <dd className="text-muted-foreground">{formatTeamDate(preview.expiresAt)}</dd>
        </div>
      </dl>
      <div className="flex w-full flex-col gap-2">
        <Button className="w-full" onClick={() => void accept()} disabled={invite.isAccepting}>
          {invite.isAccepting ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          Accept and join
        </Button>
        <Button variant="ghost" className="w-full" asChild>
          <Link to="/dashboard">Not now</Link>
        </Button>
      </div>
    </AuthCard>
  )
}
