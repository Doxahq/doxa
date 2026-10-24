import { Check, Loader2, X } from "lucide-react"

import { cn } from "~/lib/utils"

export type ProgressStepState = "done" | "current" | "failed" | "pending"

export interface ProgressStepItem {
  label: string
  detail: string
  state: ProgressStepState
}

const STATE_TEXT: Record<ProgressStepState, string> = {
  done: "done",
  current: "in progress",
  failed: "failed",
  pending: "not started",
}

/**
 * A vertical list of steps for a long action, such as a publish. Each step
 * shows its state, and a live region reads the current step aloud.
 */
export function ProgressSteps({ label, steps }: { label: string; steps: readonly ProgressStepItem[] }) {
  const active = steps.find((step) => step.state === "failed" || step.state === "current")
    ?? steps.filter((step) => step.state === "done").at(-1)

  return (
    <div>
      <ol aria-label={label} className="flex flex-col">
        {steps.map((step, index) => {
          const next = steps[index + 1]
          return (
            <li
              key={step.label}
              aria-current={step.state === "current" ? "step" : undefined}
              className="relative flex gap-3 pb-4 last:pb-0"
            >
              {next ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-6 bottom-0.5 left-[10.5px] w-px",
                    step.state === "done" ? "bg-success/45" : "bg-border",
                  )}
                />
              ) : null}
              <StepMarker state={step.state} />
              <div className="min-w-0 flex-1 pt-px">
                <p
                  className={cn(
                    "font-mono text-[11px] leading-5 font-semibold tracking-[0.14em] uppercase",
                    step.state === "pending" && "text-muted-foreground",
                    step.state === "current" && "text-foreground",
                    step.state === "done" && "text-body",
                    step.state === "failed" && "text-danger",
                  )}
                >
                  {step.label}
                  <span className="sr-only">, {STATE_TEXT[step.state]}</span>
                </p>
                <p
                  className={cn(
                    "truncate text-[12.5px] leading-4.5",
                    step.state === "pending" ? "text-faint" : "text-muted-foreground",
                  )}
                >
                  {step.detail}
                </p>
              </div>
            </li>
          )
        })}
      </ol>
      <p role="status" className="sr-only">
        {active ? `${active.label}: ${STATE_TEXT[active.state]}` : ""}
      </p>
    </div>
  )
}

function StepMarker({ state }: { state: ProgressStepState }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative z-10 flex size-[22px] shrink-0 items-center justify-center rounded-sm border [&_svg]:size-3",
        state === "done" && "border-success/40 bg-success/10 text-success",
        state === "current" && "border-primary/60 bg-primary-wash text-primary-text",
        state === "failed" && "border-danger/45 bg-danger/10 text-danger",
        state === "pending" && "border-border bg-popover text-faint",
      )}
    >
      {state === "done" ? <Check strokeWidth={3} /> : null}
      {state === "current" ? <Loader2 className="animate-spin" /> : null}
      {state === "failed" ? <X strokeWidth={3} /> : null}
      {state === "pending" ? <span className="size-1 bg-current" /> : null}
    </span>
  )
}
