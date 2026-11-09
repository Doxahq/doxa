import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { Check } from "lucide-react"

import { McpConnectCard } from "~/components/dashboard/new-project/mcp-connect-card"
import { Button } from "~/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogTitle } from "~/components/ui/dialog"
import { countFinishedSteps, type SetupStep, type SetupStepId } from "~/lib/dashboard/project-setup-model"
import { cn } from "~/lib/utils"

const MARK_CLASS: Record<SetupStep["status"], string> = {
  done: "border-success/35 bg-success/10 text-success",
  skipped: "border-border text-label",
  current: "border-primary bg-primary-wash text-primary-text",
  upcoming: "border-border text-label",
}

interface SetupChecklistProps {
  projectId: string
  steps: readonly SetupStep[]
  onConnectRepository: () => void
  onStartGeneration: () => void
  isGenerating: boolean
  onSkip: (step: SetupStepId) => void
  onHide: () => void
}

function StepAction(props: SetupChecklistProps & { step: SetupStep; onConnectAgent: () => void }) {
  const { projectId } = props
  switch (props.step.id) {
    case "repository":
      return (
        <Button size="sm" onClick={props.onConnectRepository}>
          Connect repository
        </Button>
      )
    case "instructions":
      return (
        <Button size="sm" asChild>
          <Link to="/dashboard/projects/$projectId/doxabot/instructions" params={{ projectId }}>
            Add instructions
          </Link>
        </Button>
      )
    case "generation":
      return (
        <Button size="sm" disabled={props.isGenerating} onClick={props.onStartGeneration}>
          {props.isGenerating ? "Generating…" : "Start generation"}
        </Button>
      )
    case "agent":
      return (
        <Button size="sm" onClick={props.onConnectAgent}>
          Connect agent
        </Button>
      )
    case "domain":
      return (
        <Button size="sm" asChild>
          <Link to="/dashboard/projects/$projectId/site/domains" params={{ projectId }}>
            Add domain
          </Link>
        </Button>
      )
  }
}

/** The steps from a new project to a working docs site. */
export function SetupChecklist(props: SetupChecklistProps) {
  const [isAgentDialogOpen, setIsAgentDialogOpen] = useState(false)
  const finished = countFinishedSteps(props.steps)

  return (
    <section aria-labelledby="setup-title" className="surface-card">
      <div className="flex flex-col gap-3 border-b border-divider px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="setup-title" className="text-[15px] font-semibold text-foreground">
            Finish setting up your docs
          </h2>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-label uppercase">
              {finished} of {props.steps.length} done
            </span>
            <Button variant="ghost" size="sm" className="h-7" onClick={props.onHide}>
              Hide
            </Button>
          </div>
        </div>
        <div
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={0}
          aria-valuemax={props.steps.length}
          aria-valuenow={finished}
          className="h-1 overflow-hidden rounded-sm bg-divider"
        >
          <div className="h-full bg-primary" style={{ width: `${(finished / props.steps.length) * 100}%` }} />
        </div>
      </div>

      <ol>
        {props.steps.map((step, index) => (
          <li
            key={step.id}
            className={cn(
              "flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center",
              index > 0 && "border-t border-divider",
              step.status === "current" && "bg-overlay",
            )}
          >
            <div className="flex min-w-0 flex-1 items-center gap-3.5">
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px]",
                  MARK_CLASS[step.status],
                )}
              >
                {step.status === "done" ? <Check aria-hidden="true" className="size-3.5" /> : index + 1}
              </span>
              <div className="flex min-w-0 flex-col gap-0.5">
                <p
                  className={cn(
                    "flex items-center gap-2 text-sm font-medium",
                    step.status === "done" || step.status === "skipped" ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {step.title}
                  {step.status === "skipped" || step.optional ? (
                    <span className="text-xs font-normal text-label">
                      {step.status === "skipped" ? "Skipped" : "Optional"}
                    </span>
                  ) : null}
                </p>
                <p className="text-[13px] text-muted-foreground">{step.text}</p>
              </div>
            </div>
            {step.status === "current" ? (
              <div className="flex shrink-0 items-center gap-1">
                {step.optional ? (
                  <Button variant="ghost" size="sm" onClick={() => props.onSkip(step.id)}>
                    Skip
                  </Button>
                ) : null}
                <StepAction {...props} step={step} onConnectAgent={() => setIsAgentDialogOpen(true)} />
              </div>
            ) : null}
          </li>
        ))}
      </ol>

      <Dialog open={isAgentDialogOpen} onOpenChange={setIsAgentDialogOpen}>
        <DialogContent className="overscroll-contain shadow-none sm:max-w-[1000px]">
          <DialogTitle className="sr-only">Connect an agent with MCP</DialogTitle>
          <DialogBody className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto">
            <McpConnectCard insideDialog />
          </DialogBody>
        </DialogContent>
      </Dialog>
    </section>
  )
}
