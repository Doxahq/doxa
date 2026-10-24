import { useState, type FormEvent } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { ChevronRight, Loader2, Plus, Users } from "lucide-react"
import { MAX_TEAM_NAME_LENGTH } from "@doxahq/contracts/teams"

import {
  DashboardHeader,
  EmptyState,
  PageBody,
  PageHeading,
  SectionLabel,
} from "~/components/dashboard/dashboard-header"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { TEAM_ROLE_LABELS } from "~/lib/dashboard/teams-model"
import { TeamsSkeleton } from "~/components/dashboard/skeletons/account-skeletons"
import { useIsFirstLoad } from "~/lib/dashboard/use-first-load"
import { useTeams } from "~/lib/dashboard/use-teams"

/** `/dashboard/teams`: the user's teams and a form to create one (spec §5). */
export function TeamsPage() {
  const state = useTeams()

  // The skeleton is for the first load only (see `useIsFirstLoad`).
  const isFirstLoad = useIsFirstLoad([{ isPending: state.isLoading }])
  if (isFirstLoad) return <TeamsSkeleton />

  return (
    <>
      <DashboardHeader title="Teams" />
      <PageBody>
        <PageHeading
          label="Account"
          title="Teams"
          description="A team shares projects with its members. Each member's role decides what they and their agents can do."
        />
        <CreateTeamForm create={state.create} isCreating={state.isCreating} error={state.createError} />

        <section className="flex flex-col gap-3">
          <SectionLabel>Your teams</SectionLabel>
          {state.loadError ? (
            <Alert variant="destructive">
              <AlertDescription>{state.loadError}</AlertDescription>
            </Alert>
          ) : state.teams.length === 0 ? (
            <EmptyState
              icon={<Users />}
              title="No teams yet"
              description="Create a team, then invite members with a link and move projects into it."
              className="max-w-none"
            />
          ) : (
            <ul className="surface-card">
              {state.teams.map((team) => (
                <li key={team.id} className="border-t border-divider first:border-t-0">
                  <Link
                    to="/dashboard/teams/$teamId"
                    params={{ teamId: team.id }}
                    className="flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-surface-hover"
                  >
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="truncate text-[14.5px] font-medium text-foreground">{team.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {plural(team.memberCount, "member")} · {plural(team.projectCount, "project")}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <Badge variant="muted">{TEAM_ROLE_LABELS[team.role]}</Badge>
                      <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </PageBody>
    </>
  )
}

function CreateTeamForm({
  create,
  isCreating,
  error,
}: {
  create: (name: string) => Promise<{ id: string }>
  isCreating: boolean
  error: string | null
}) {
  const navigate = useNavigate()
  const [name, setName] = useState("")
  const trimmed = name.trim()

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (trimmed.length === 0 || isCreating) return
    try {
      const team = await create(trimmed)
      setName("")
      void navigate({ to: "/dashboard/teams/$teamId", params: { teamId: team.id } })
    } catch {
      // The form shows the error.
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>Create a team</SectionLabel>
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          aria-label="Team name"
          placeholder="Team name"
          value={name}
          maxLength={MAX_TEAM_NAME_LENGTH}
          onChange={(event) => setName(event.target.value)}
          className="sm:max-w-sm"
        />
        <Button type="submit" size="lg" className="w-fit shrink-0" disabled={trimmed.length === 0 || isCreating}>
          {isCreating ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Plus aria-hidden="true" />}
          Create team
        </Button>
      </form>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </section>
  )
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}
