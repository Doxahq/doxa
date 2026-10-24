import { AlertCircle, Bot, Loader2, LockKeyhole } from "lucide-react"
import { toast } from "sonner"

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "~/components/ui/alert"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card"
import { DoxabotMergeTrigger } from "~/components/dashboard/doxabot-merge-trigger"
import { getDoxabotViewModel } from "~/lib/dashboard/doxabot-model"
import { useProjectCapabilities } from "~/lib/dashboard/use-project-capabilities"
import { useProjectDoxabot } from "~/lib/dashboard/use-project-doxabot"
import { getErrorMessage } from "~/lib/errors"

/**
 * Doxabot: the bot that runs on pull requests and prepares documentation
 * previews. Shown as a card on the project Settings page.
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
      <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Bot
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-muted-foreground"
          />
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardTitle>
              <h3>Doxabot</h3>
            </CardTitle>
            <CardDescription>
              Generates review-only documentation previews for pull requests
              that target your repository&apos;s default branch. Doxabot
              analyzes eligible code changes without changing published docs.
            </CardDescription>
          </div>
        </div>
        <Badge variant="outline" className="w-fit shrink-0">
          <LockKeyhole aria-hidden="true" className="mr-1 size-3" />
          Private repositories only
        </Badge>
      </CardHeader>

      <CardContent className="flex flex-col gap-5 border-t border-border pt-5">
        <div
          className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
          aria-live="polite"
        >
          <div className="flex min-w-0 flex-col gap-2">
            <Badge variant={view.statusTone} className="w-fit">
              {view.statusLabel}
            </Badge>
            {!showAlert ? (
              <div className="flex flex-col gap-1">
                <p className="font-medium text-foreground">{view.title}</p>
                <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                  {view.description}
                </p>
              </div>
            ) : null}
          </div>

          {canChange ? (
            <Button
              type="button"
              className="min-h-11 motion-reduce:transition-none"
              onClick={() => void updateEnabled()}
              disabled={view.actionDisabled}
              aria-describedby={showAlert ? "doxabot-availability" : undefined}
            >
              {state.isSaving ? (
                <Loader2
                  aria-hidden="true"
                  className="animate-spin motion-reduce:animate-none"
                />
              ) : (
                <Bot aria-hidden="true" />
              )}
              {view.actionLabel}
            </Button>
          ) : null}
        </div>

        {state.settings?.enabled && state.settings.available ? (
          <DoxabotMergeTrigger
            settings={state.settings}
            disabled={!canChange || state.isSaving}
            onUpdate={state.update}
          />
        ) : null}

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
      </CardContent>
    </Card>
  )
}
