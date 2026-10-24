import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronRight, Loader2, Users } from "lucide-react"

import { Select } from "~/components/dashboard/content/site-settings/fields/controls"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import { TEAM_ROLE_LABELS, canMoveProjectToTeam, manageableTeams } from "~/lib/dashboard/teams-model"
import { useMoveProjectToTeam, useTeams } from "~/lib/dashboard/use-teams"
import { projectDetailQueryOptions } from "~/lib/queries/dashboard"

/**
 * Project settings → Team. A team project names its team; the owner of a
 * personal project can move it into a team they manage (spec §5).
 */
export function ProjectTeamCard({ projectId }: { projectId: string }) {
  const detail = useQuery(projectDetailQueryOptions(projectId)).data ?? null
  if (detail === null) return null
  const { project, role } = detail

  return (
    <Card>
      <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Users aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardTitle>
              <h3>Team</h3>
            </CardTitle>
            <CardDescription>
              {project.team
                ? `${project.team.name} shares this project. Your role: ${TEAM_ROLE_LABELS[role]}.`
                : "A personal project. Move it into a team to share it with the team's members."}
            </CardDescription>
          </div>
        </div>
        {project.team ? (
          <Button variant="outline" className="w-fit shrink-0" asChild>
            <Link to="/dashboard/teams/$teamId" params={{ teamId: project.team.id }}>
              Open team
              <ChevronRight aria-hidden="true" />
            </Link>
          </Button>
        ) : null}
      </CardHeader>
      {canMoveProjectToTeam(project, role) ? (
        <CardContent>
          <MoveToTeam projectId={projectId} projectName={project.name} />
        </CardContent>
      ) : null}
    </Card>
  )
}

function MoveToTeam({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { teams, isLoading } = useTeams()
  const targets = manageableTeams(teams)
  const move = useMoveProjectToTeam(projectId)
  const [picked, setPicked] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const teamId = picked ?? targets[0]?.id ?? null
  const team = targets.find((candidate) => candidate.id === teamId) ?? null

  // The settings page waits for the teams before it shows this card, so this
  // has no loading state of its own.
  if (isLoading) return null
  if (targets.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        You are not an owner or admin of any team.{" "}
        <Link to="/dashboard/teams" className="text-primary-text hover:underline">
          Create a team
        </Link>{" "}
        to share this project.
      </p>
    )
  }

  async function confirmMove() {
    if (teamId === null) return
    try {
      await move.move(teamId)
      setOpen(false)
    } catch {
      // The dialog shows the error and stays open.
    }
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <Select
        aria-label="Team"
        className="sm:max-w-xs"
        value={teamId ?? ""}
        options={targets.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
        onValueChange={setPicked}
        placeholder="Choose a team"
      />
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (move.isMoving) return
          if (next) move.reset()
          setOpen(next)
        }}
      >
        <Button variant="outline" className="w-fit" onClick={() => setOpen(true)} disabled={team === null}>
          Move to team
        </Button>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move {projectName} to {team?.name}?</DialogTitle>
            <DialogDescription>Every member of the team gets access, by their role.</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              You stay the project owner: storage, billing and the GitHub connection stay with you, and your
              connected agents keep working. You cannot move the project back out of the team here.
            </p>
            {move.error ? (
              <Alert variant="destructive">
                <AlertDescription>{move.error}</AlertDescription>
              </Alert>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" disabled={move.isMoving}>
                Cancel
              </Button>
            </DialogClose>
            <Button onClick={() => void confirmMove()} disabled={move.isMoving}>
              {move.isMoving ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
              Move project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
