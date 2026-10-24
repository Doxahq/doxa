import { useState, type FormEvent } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { ArrowLeft, Loader2 } from "lucide-react"
import { MAX_TEAM_NAME_LENGTH, type TeamDetail } from "@doxahq/contracts/teams"

import {
  DashboardHeader,
  PageBody,
  PageHeading,
  SectionDescription,
  SectionLabel,
} from "~/components/dashboard/dashboard-header"
import { PageBackNavigation } from "~/components/dashboard/page-back-navigation"
import { DeleteTeamCard } from "~/components/dashboard/teams/delete-team-card"
import { LeaveTeamSection } from "~/components/dashboard/teams/leave-team-section"
import { TeamInvitesSection } from "~/components/dashboard/teams/team-invites-section"
import { TeamMembersSection } from "~/components/dashboard/teams/team-members-section"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { useDashboardAuth } from "~/lib/auth/dashboard-auth-context"
import { TEAM_ROLE_LABELS, leaveBlockReason } from "~/lib/dashboard/teams-model"
import { useTeam } from "~/lib/dashboard/use-teams"
import { TeamSkeleton } from "~/components/dashboard/skeletons/account-skeletons"
import { useIsFirstLoad } from "~/lib/dashboard/use-first-load"

/** `/dashboard/teams/<id>`: one team's members, invite links and projects. */
export function TeamPage({ teamId }: { teamId: string }) {
  const { user } = useDashboardAuth()
  const navigate = useNavigate()
  const state = useTeam(teamId)
  const team = state.team

  async function leave() {
    if (!user) return
    try {
      await state.removeMember(user.id)
      void navigate({ to: "/dashboard/teams" })
    } catch {
      // The members section shows the error.
    }
  }

  // The skeleton is for the first load only (see `useIsFirstLoad`).
  const isFirstLoad = useIsFirstLoad([{ isPending: state.isLoading }])
  if (isFirstLoad) return <TeamSkeleton />

  return (
    <>
      <DashboardHeader title={team?.name ?? "Team"} />
      <PageBody>
        <PageBackNavigation>
          <Link to="/dashboard/teams">
            <ArrowLeft aria-hidden="true" />
            Teams
          </Link>
        </PageBackNavigation>

        {state.loadError ? (
          <Alert variant="destructive">
            <AlertDescription>{state.loadError}</AlertDescription>
          </Alert>
        ) : null}

        {team ? (
          <>
            <PageHeading
              label="Team"
              title={team.name}
              description={`Your role: ${TEAM_ROLE_LABELS[team.role]}. ${team.members.length} ${team.members.length === 1 ? "member" : "members"}.`}
            />
            {team.permissions.manage ? (
              <RenameTeamForm
                key={team.name}
                name={team.name}
                isRenaming={state.isRenaming}
                error={state.renameError}
                onRename={state.rename}
              />
            ) : null}
            <TeamMembersSection
              team={team}
              viewerUserId={user?.id ?? null}
              changingUserId={state.changingUserId}
              removingUserId={state.removingUserId}
              error={state.memberError}
              onChangeRole={state.changeRole}
              onRemove={(userId) => void state.removeMember(userId).catch(() => undefined)}
            />
            {team.permissions.manage ? (
              <TeamInvitesSection
                team={team}
                isCreating={state.isCreatingInvite}
                createError={state.inviteError}
                revokingInviteId={state.revokingInviteId}
                revokeError={state.revokeError}
                onCreate={state.createInvite}
                onRevoke={state.revokeInvite}
              />
            ) : null}
            <TeamProjectsSection team={team} />
            <LeaveTeamSection
              blockReason={leaveBlockReason(team.members, user?.id ?? null)}
              isLeaving={state.removingUserId === user?.id}
              onLeave={() => void leave()}
            />
            {team.permissions.delete ? (
              <DeleteTeamCard
                teamName={team.name}
                hasProjects={team.projects.length > 0}
                isDeleting={state.isDeleting}
                error={state.deleteError}
                deleteTeam={state.deleteTeam}
                onDeleted={() => void navigate({ to: "/dashboard/teams" })}
                resetError={state.resetDelete}
              />
            ) : null}
          </>
        ) : null}
      </PageBody>
    </>
  )
}

function RenameTeamForm({
  name,
  isRenaming,
  error,
  onRename,
}: {
  name: string
  isRenaming: boolean
  error: string | null
  onRename: (name: string) => Promise<unknown>
}) {
  const [draft, setDraft] = useState(name)
  const trimmed = draft.trim()
  const changed = trimmed.length > 0 && trimmed !== name

  function submit(event: FormEvent) {
    event.preventDefault()
    if (changed && !isRenaming) void onRename(trimmed).catch(() => undefined)
  }

  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>Name</SectionLabel>
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          aria-label="Team name"
          value={draft}
          maxLength={MAX_TEAM_NAME_LENGTH}
          onChange={(event) => setDraft(event.target.value)}
          className="sm:max-w-sm"
        />
        <Button type="submit" variant="outline" size="lg" className="w-fit shrink-0" disabled={!changed || isRenaming}>
          {isRenaming ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          Rename
        </Button>
      </form>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </section>
  )
}

function TeamProjectsSection({ team }: { team: TeamDetail }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <SectionLabel>Projects</SectionLabel>
        <SectionDescription>
          A project owner moves a personal project here from the project's settings.
        </SectionDescription>
      </div>
      {team.projects.length === 0 ? (
        <p className="surface-card px-5 py-4 text-sm text-muted-foreground">No projects in this team yet.</p>
      ) : (
        <ul className="surface-card">
          {team.projects.map((project) => (
            <li key={project.id} className="border-t border-divider first:border-t-0">
              <Link
                to="/dashboard/projects/$projectId"
                params={{ projectId: project.id }}
                className="flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-surface-hover"
              >
                <span className="truncate text-sm text-foreground">{project.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">/{project.slug}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
