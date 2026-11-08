import { AlertCircle, GitPullRequest, Loader2, LockKeyhole } from "lucide-react"
import { toast } from "sonner"

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "~/components/ui/alert"
import { Badge } from "~/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card"
import { Switch } from "~/components/dashboard/content/site-settings/fields/controls"
import { DoxabotMergeTrigger } from "~/components/dashboard/doxabot-merge-trigger"
import { getDoxabotViewModel } from "~/lib/dashboard/doxabot-model"
import { useProjectCapabilities } from "~/lib/dashboard/use-project-capabilities"
import { useProjectDoxabot } from "~/lib/dashboard/use-project-doxabot"
import { getErrorMessage } from "~/lib/errors"

/**
 * Doxabot on pull requests: it prepares documentation previews. Shown as a
 * card on the project's Doxabot page.
 */
export function DoxabotSettingsCard({ projectId }: { projectId: string }) {
  const state = useProjectDoxabot(projectId)
  const view = getDoxabotViewModel(state)
  // Doxabot starts generations, so turning it on or off needs `generation.run`.
  const canChange = useProjectCapabilities(projectId).can("generation.run")

  async function updateEnabled() {
    try {
      await state.updateEnabled(view.nextEnabled)
      toast.success(
        view.nextEnabled ? "Doxabot enabled" : "Doxabot disabled",
      )
    } catch (caught) {
      toast.error(
        getErrorMessage(caught, "Failed to update Doxabot settings."),
      )
    }
  }

  const showAlert =
    view.kind === "error" ||
    (state.settings !== null && !state.settings.available)

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <GitPullRequest
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-muted-foreground"
          />
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardTitle>
              <h3 id="doxabot-pull-request-previews">Pull request previews</h3>
            </CardTitle>
            <CardDescription>
              Generates review-only documentation previews for pull requests
              that target the production branch. Doxabot
              analyzes eligible code changes without changing published docs.
              Each preview uses credits.
            </CardDescription>
          </div>
        </div>
        {canChange ? (
          <span className="mt-0.5 flex shrink-0 items-center gap-2">
            {state.isSaving ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
            ) : null}
            <Switch
              aria-labelledby="doxabot-pull-request-previews"
              aria-describedby={showAlert ? "doxabot-availability" : "doxabot-pull-request-status"}
              checked={state.settings?.enabled ?? false}
              disabled={view.actionDisabled}
              onCheckedChange={() => void updateEnabled()}
            />
          </span>
        ) : null}
      </CardHeader>

      <CardContent className="flex flex-col gap-4 border-t border-border pt-4">
        {showAlert ? (
          <Alert
            id="doxabot-availability"
            variant={view.kind === "error" ? "destructive" : "default"}
          >
            {view.kind === "error" ? (
              <AlertCircle aria-hidden="true" />
            ) : (
              <LockKeyhole aria-hidden="true" />
            )}
            <AlertTitle>{view.title}</AlertTitle>
            <AlertDescription>{view.description}</AlertDescription>
          </Alert>
        ) : null}

        {state.settings?.enabled && state.settings.available ? (
          <DoxabotMergeTrigger
            settings={state.settings}
            disabled={!canChange || state.isSaving}
            onUpdate={state.update}
          />
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3" aria-live="polite">
          <p id="doxabot-pull-request-status" className="text-sm text-muted-foreground">
            {showAlert ? view.statusLabel : view.description}
          </p>
          <Badge variant="outline" className="w-fit shrink-0">
            <LockKeyhole aria-hidden="true" className="mr-1 size-3" />
            Private repositories only
          </Badge>
        </div>
      </CardContent>
    </Card>
  )
}
