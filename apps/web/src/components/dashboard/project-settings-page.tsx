import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { AlertCircle, ChevronRight, DatabaseZap, Link2, Loader2, ShieldCheck } from "lucide-react"
import { toast } from "sonner"

import { PageBody, PageHeading } from "~/components/dashboard/dashboard-header"
import { ProjectDeleteCard } from "~/components/dashboard/project-delete-card"
import { ProjectTeamCard } from "~/components/dashboard/project-team-card"
import { DoxabotSettingsCard } from "~/components/dashboard/project-doxabot-page"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card"
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog"
import { canMoveProjectToTeam } from "~/lib/dashboard/teams-model"
import { useProjectCapabilities } from "~/lib/dashboard/use-project-capabilities"
import { useProjectGenerationCache } from "~/lib/dashboard/use-project-generation-cache"
import { getErrorMessage } from "~/lib/errors"
import { projectDetailQueryOptions, projectDoxabotQueryOptions } from "~/lib/queries/dashboard"
import { teamsQueryOptions } from "~/lib/queries/teams"
import { ProjectSettingsSkeleton } from "~/components/dashboard/skeletons/settings-skeletons"
import { useIsFirstLoad } from "~/lib/dashboard/use-first-load"

export function ProjectSettingsPage({ projectId }: { projectId: string }) {
  const state = useProjectGenerationCache(projectId)
  const projectQuery = useQuery(projectDetailQueryOptions(projectId))
  // The cards read these too. The page waits for all of them, so it shows
  // one skeleton and then every card at once, not cards popping in one by one.
  const doxabotQuery = useQuery(projectDoxabotQueryOptions(projectId))
  const project = projectQuery.data?.project ?? null
  // The Team card lists the teams that can take the project. Only an owner of
  // a personal project sees that list, so only then does the page load it.
  const canMoveToTeam = projectQuery.data
    ? canMoveProjectToTeam(projectQuery.data.project, projectQuery.data.role)
    : false
  const teamsQuery = useQuery({ ...teamsQueryOptions(), enabled: canMoveToTeam })
  const { can } = useProjectCapabilities(projectId)
  const [open, setOpen] = useState(false)

  async function clearCache(): Promise<void> {
    try {
      await state.clear()
      toast.success("Generation cache cleared")
      setOpen(false)
    } catch (caught) {
      toast.error(
        getErrorMessage(caught, "Failed to clear the generation cache."),
      )
    }
  }

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen && state.isClearing) return
    setOpen(nextOpen)
  }

  const isFirstLoad = useIsFirstLoad([
    { isPending: state.isLoading },
    projectQuery,
    doxabotQuery,
    { isPending: canMoveToTeam && teamsQuery.isPending },
  ])

  if (isFirstLoad) return <ProjectSettingsSkeleton />

  return (
    <PageBody className="max-w-4xl">
      <PageHeading
        label="Project"
        title="Settings"
        description="How this project's documentation is generated and kept up to date."
      />

      <section className="flex flex-col gap-4">
        <DoxabotSettingsCard projectId={projectId} />

        <AgentApprovalsCard projectId={projectId} />

        <ProjectTeamCard projectId={projectId} />

        {state.error ? (
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" className="size-4" />
            <AlertTitle>Unable to load settings</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <DatabaseZap
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-muted-foreground"
              />
              <div className="flex min-w-0 flex-col gap-1.5">
                <CardTitle>
                  <h3>Generation cache</h3>
                </CardTitle>
                <CardDescription>
                  Generations reuse the previous analysis, structure, and pages
                  wherever the source has not changed. Clear the cache to make
                  the next generation analyze the repository from scratch.
                </CardDescription>
              </div>
            </div>
          </CardHeader>

          <CardContent className="flex flex-col gap-4">
            <p className="font-mono text-xs uppercase text-muted-foreground">
              {state.isLoading
                ? "Loading…"
                : state.cache?.clearedAt
                  ? `Last cleared ${new Date(state.cache.clearedAt).toLocaleString()}`
                  : "Never cleared"}
            </p>

            {can("generation.run") ? (
              <Dialog open={open} onOpenChange={handleOpenChange}>
                <DialogTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-fit"
                    disabled={state.isLoading || state.cache === null}
                  >
                    <DatabaseZap aria-hidden="true" className="mr-2 size-4" />
                    Clear generation cache
                  </Button>
                </DialogTrigger>

                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Clear generation cache?</DialogTitle>
                    <DialogDescription>
                      The next generation will analyze the repository from
                      scratch and rebuild every page.
                    </DialogDescription>
                  </DialogHeader>

                  <DialogBody className="flex flex-col gap-3">
                    <p className="text-sm text-muted-foreground">
                      Your published documentation stays online and unchanged
                      until that generation finishes. Because nothing is reused,
                      the next run takes noticeably longer and the resulting
                      structure may differ from the current one.
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Each open pull request will also do one full rebuild the
                      next time it runs, instead of reusing its previous
                      preview. Previews that are already published stay online
                      until then.
                    </p>
                  </DialogBody>

                  <DialogFooter>
                    <DialogClose asChild>
                      <Button variant="ghost" disabled={state.isClearing}>
                        Cancel
                      </Button>
                    </DialogClose>
                    <Button onClick={clearCache} disabled={state.isClearing}>
                      {state.isClearing ? (
                        <Loader2
                          aria-hidden="true"
                          className="mr-2 size-4 animate-spin"
                        />
                    ) : null}
                    Clear cache
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <Link2
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-muted-foreground"
              />
              <div className="flex min-w-0 flex-col gap-1.5">
                <CardTitle>
                  <h3>Generation preview access</h3>
                </CardTitle>
                <CardDescription>
                  Private previews return when preview authentication moves to
                  the new domain. Every generation preview is public today.
                </CardDescription>
              </div>
            </div>

            {/*
              Re-enable this control only after these changes:
              1. Add a signed short-lived token exchange.
              2. Use a host-only redemption cookie on doxa.page.
              3. Set DOCS_PREVIEW_GATE_ENABLED=true.
              4. Re-enable this control.
            */}
            <Button
              type="button"
              variant="outline"
              className="w-fit shrink-0"
              disabled
            >
              Previews are public
            </Button>
          </CardHeader>
        </Card>

        {can("project.delete") ? (
          <ProjectDeleteCard
            projectId={projectId}
            projectName={project?.name ?? null}
            projectSlug={project?.slug ?? null}
          />
        ) : null}
      </section>
    </PageBody>
  )
}

/** Links to Project settings → Agent approvals. */
function AgentApprovalsCard({ projectId }: { projectId: string }) {
  return (
    <Card>
      <CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardTitle>
              <h3>Agent approvals</h3>
            </CardTitle>
            <CardDescription>
              Choose which agent actions run at once, which wait for you, and which never run.
            </CardDescription>
          </div>
        </div>
        <Button variant="outline" className="w-fit shrink-0" asChild>
          <Link to="/dashboard/projects/$projectId/settings/approvals" params={{ projectId }}>
            Manage
            <ChevronRight aria-hidden="true" />
          </Link>
        </Button>
      </CardHeader>
    </Card>
  )
}
