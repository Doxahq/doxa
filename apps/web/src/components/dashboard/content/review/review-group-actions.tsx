import { useState } from "react"
import type { GenerationReviewDecision, GenerationReviewPage } from "@doxahq/contracts/generation-reviews"
import { Check, Loader2, X } from "lucide-react"

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip"
import { REVIEW_CHANGE_COPY } from "~/lib/dashboard/generation-review-model"
import { pagesToDecide } from "~/lib/dashboard/use-review-decisions"
import { cn } from "~/lib/utils"

/** What a sidebar group needs to decide on all of its pages at once. */
export interface ReviewGroupDecisions {
  /** Saves one decision for every page of the list. Resolves once it is saved. */
  onDecideAll: (pages: readonly GenerationReviewPage[], decision: GenerationReviewDecision) => Promise<unknown>
  /** True while another decision, a publish or a discard runs. */
  disabled: boolean
}

const GROUP_DECISIONS: readonly GenerationReviewDecision[] = ["accepted", "rejected"]

/**
 * The two buttons of a sidebar group: accept every page of the group, or
 * reject every page. They act on the pages that the group shows, and skip
 * the pages that already hold the decision.
 */
export function ReviewGroupActions(props: {
  pages: readonly GenerationReviewPage[]
  decisions: ReviewGroupDecisions
}) {
  const [saving, setSaving] = useState<GenerationReviewDecision | null>(null)
  const [first] = props.pages
  if (!first) return null
  const copy = REVIEW_CHANGE_COPY[first.change]

  async function decideAll(decision: GenerationReviewDecision): Promise<void> {
    setSaving(decision)
    try {
      await props.decisions.onDecideAll(props.pages, decision)
    } finally {
      setSaving(null)
    }
  }

  return (
    // A group can render outside the dashboard provider, in a test for example, so it brings its own.
    <TooltipProvider delayDuration={300}>
      <span className="flex items-center gap-0.5">
        {GROUP_DECISIONS.map((decision) => {
          const choice = decision === "accepted" ? copy.accept : copy.reject
          const count = pagesToDecide(props.pages, decision).length
          const Icon = decision === "accepted" ? Check : X
          const label = `${choice.allLabel} (${copy.tag.toLowerCase()} pages)`
          return (
            <Tooltip key={decision}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={label}
                  disabled={count === 0 || saving !== null || props.decisions.disabled}
                  onClick={() => void decideAll(decision)}
                  className={cn(
                    "flex size-[22px] items-center justify-center rounded-sm text-muted-foreground transition-colors",
                    "hover:bg-overlay hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
                    decision === "accepted" && "hover:text-primary-text",
                  )}
                >
                  {saving === decision ? (
                    <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                  ) : (
                    <Icon aria-hidden="true" className="size-3.5" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                <span className="font-medium text-foreground">{choice.allLabel}</span>{" "}
                <span className="text-muted-foreground">
                  · {count} {count === 1 ? "page" : "pages"}
                </span>
              </TooltipContent>
            </Tooltip>
          )
        })}
      </span>
    </TooltipProvider>
  )
}
