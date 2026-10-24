import type { GenerationReviewPageChange } from "@doxahq/contracts/generation-reviews"

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip"
import {
  describeReviewChanges,
  REVIEW_CHANGE_COPY,
  REVIEW_CHANGE_MARK,
  REVIEW_CHANGES,
  REVIEW_STATE_LABEL,
  type ReviewChangeCounts,
  type ReviewChangeTone,
  type ReviewState,
} from "~/lib/dashboard/generation-review-model"
import { cn } from "~/lib/utils"

const TONE_DOT_CLASS: Record<ReviewChangeTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
}

/** A tinted ground with the stroke in the tone, for the change icon and its chip. */
const TONE_TINT_CLASS: Record<ReviewChangeTone, string> = {
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-destructive/15 text-destructive",
}

/**
 * What the generation does to a page, as one colored dot: green for a new
 * page, orange for a rewritten page, like an edited page outside a review,
 * and red for a removed page. A tooltip names the change, so the colors
 * are quick to learn.
 */
export function ReviewChangeDot({
  change,
  className,
}: {
  change: GenerationReviewPageChange
  className?: string
}) {
  const mark = REVIEW_CHANGE_MARK[change]
  return (
    // A row can sit outside the dashboard provider, in a test for example, so the dot brings its own.
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* The box around the dot gives the pointer a bigger target than the dot. */}
          <span
            role="img"
            aria-label={mark.label}
            className={cn("flex size-4 shrink-0 items-center justify-center", className)}
          >
            <span aria-hidden="true" className={cn("size-1.5 rounded-full", TONE_DOT_CLASS[mark.tone])} />
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-56 text-xs">
          <span className="font-medium text-foreground">{mark.label}.</span>{" "}
          <span className="text-muted-foreground">{mark.description}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * The changes inside a closed group: one dot for each kind of change, and
 * the counts in the tooltip. Nothing when the group has no change.
 */
export function ReviewChangeCountDots({ counts }: { counts: ReviewChangeCounts }) {
  const summary = describeReviewChanges(counts)
  if (!summary) return null
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span role="img" aria-label={summary} className="flex h-4 shrink-0 items-center gap-0.5 px-0.5">
            {REVIEW_CHANGES.filter((change) => counts[change] > 0).map((change) => (
              <span
                key={change}
                aria-hidden="true"
                className={cn("size-1.5 rounded-full", TONE_DOT_CLASS[REVIEW_CHANGE_MARK[change].tone])}
              />
            ))}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-56 text-xs text-muted-foreground">
          {summary}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * What the generation did to a page, as a shape that never changes: + for a
 * new page, ~ for a changed page and − for a deleted page. The shapes differ,
 * so the marks do not depend on color alone.
 */
export function ReviewChangeIcon({ change, className }: { change: GenerationReviewPageChange; className?: string }) {
  const mark = REVIEW_CHANGE_MARK[change]
  return (
    <span
      role="img"
      aria-label={`${mark.label} page`}
      className={cn("inline-flex size-4 shrink-0 items-center justify-center rounded-sm", TONE_TINT_CLASS[mark.tone], className)}
    >
      <ChangeGlyph change={change} />
    </span>
  )
}

/** The tag of a change with its glyph, for the header of a review page. */
export function ReviewChangeChip({ change }: { change: GenerationReviewPageChange }) {
  return (
    <span
      className={cn(
        "inline-flex h-5.5 shrink-0 items-center gap-1.5 rounded-sm px-2 font-mono text-[10.5px] tracking-[0.08em] uppercase",
        TONE_TINT_CLASS[REVIEW_CHANGE_MARK[change].tone],
      )}
    >
      <ChangeGlyph change={change} />
      {REVIEW_CHANGE_COPY[change].tag}
    </span>
  )
}

function ChangeGlyph({ change }: { change: GenerationReviewPageChange }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 10 10" className="size-2.5" fill="none" stroke="currentColor" strokeLinecap="round">
      {change === "added" ? <path d="M2 5h6M5 2v6" strokeWidth="1.6" /> : null}
      {change === "modified" ? <path d="M1.5 5.6C2.6 3.9 3.8 3.9 5 5s2.4 1.7 3.5 0" strokeWidth="1.5" /> : null}
      {change === "removed" ? <path d="M2 5h6" strokeWidth="1.6" /> : null}
    </svg>
  )
}

/**
 * Where a page is in the review: a dashed ring while it waits, a filled
 * check once accepted, and a filled cross once rejected.
 */
export function ReviewDecisionMark({ state, className }: { state: ReviewState; className?: string }) {
  const label = REVIEW_STATE_LABEL[state]
  return (
    <svg role="img" aria-label={label} viewBox="0 0 16 16" className={cn("size-3.5 shrink-0", className)}>
      <title>{label}</title>
      {state === "to_review" ? (
        <circle cx="8" cy="8" r="6" fill="none" className="stroke-muted-foreground" strokeWidth="1.5" strokeDasharray="2.6 2.1" />
      ) : null}
      {state === "accepted" ? (
        <>
          <circle cx="8" cy="8" r="7" className="fill-primary" />
          <path
            d="M4.9 8.3l2.1 2.1 4.1-4.6"
            fill="none"
            className="stroke-background"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : null}
      {state === "rejected" ? (
        <>
          <circle cx="8" cy="8" r="7" className="fill-muted-foreground" />
          <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" className="stroke-background" strokeWidth="1.8" strokeLinecap="round" />
        </>
      ) : null}
    </svg>
  )
}
