import { useEffect } from "react"
import type { GenerationReviewPage } from "@doxahq/contracts/generation-reviews"
import { ArrowRight, ChevronDown, ChevronUp, Loader2 } from "lucide-react"

import { ReviewChangeChip, ReviewDecisionMark } from "~/components/dashboard/content/review/review-marks"
import { TOP_BAR_ICON_BUTTON_CLASS } from "~/components/dashboard/shell/top-bar"
import { Button } from "~/components/ui/button"
import {
  nextToReviewHref,
  REVIEW_CHANGE_COPY,
  REVIEW_STATE_LABEL,
  reviewChoice,
  reviewState,
  type ReviewChoice,
} from "~/lib/dashboard/generation-review-model"
import { isEditableTarget } from "~/lib/dashboard/shell-context"
import type { ContentReviewSession } from "~/lib/dashboard/use-content-review"
import type { ReviewBarDecision } from "~/lib/dashboard/use-review-decisions"
import { cn } from "~/lib/utils"

/**
 * The height of every control in the decision row. The row stretches its
 * controls, so a control whose text wraps keeps the others level with it.
 */
const CONTROL_HEIGHT_CLASS = "h-auto min-h-11.5"

/** The page decision, saved through the review. */
export interface ReviewDecisionControl {
  /** False for a role that cannot decide. */
  canDecide: boolean
  isSaving: boolean
  disabled: boolean
  onDecide: (decision: ReviewBarDecision) => void
}

/**
 * The page under review and its decision. One sentence says what the
 * generation did; the two buttons say what each choice does to the page,
 * reject on the left and accept on the right. Once decided, a box states the
 * outcome, with a way to change it and a way on to the next page to review.
 */
export function ReviewDecisionBar(props: {
  session: ContentReviewSession
  page: GenerationReviewPage
  decision: ReviewDecisionControl
  onStep: (href: string) => void
  onFinish: () => void
}) {
  const { page, decision } = props
  const state = reviewState(page)

  return (
    <section aria-label="Decision for this page" className={PAGE_BAR_CLASS}>
      <ReviewPageHeading page={page} sentence={REVIEW_CHANGE_COPY[page.change].sentence} />

      {decision.canDecide && state === "to_review" ? (
        <ReviewChoiceButtons page={page} decision={decision} />
      ) : null}
      {state !== "to_review" ? (
        <ReviewDecidedState
          session={props.session}
          page={page}
          state={state}
          decision={decision}
          onStep={props.onStep}
          onFinish={props.onFinish}
        />
      ) : null}

      <ReviewSteps steps={props.session} page={page} onStep={props.onStep} />
    </section>
  )
}

/** The bar above a changed page. It wraps when the window is narrow. */
const PAGE_BAR_CLASS =
  "flex shrink-0 flex-wrap items-center gap-x-6 gap-y-4 border-b border-border bg-card px-5 py-4"

/**
 * The bar above a changed page that nobody decides on, such as a page of a
 * pull request preview: the same heading and steps as a review, with no
 * decision.
 */
export function ReviewReadOnlyBar(props: {
  steps: ReviewStepsState
  page: GenerationReviewPage
  sentence: string
  onStep: (href: string) => void
}) {
  return (
    <section aria-label="Changed page" className={PAGE_BAR_CLASS}>
      <ReviewPageHeading page={props.page} sentence={props.sentence} />
      <ReviewSteps steps={props.steps} page={props.page} onStep={props.onStep} />
    </section>
  )
}

/** What the generation did to the page, its title and path, and one sentence about it. */
function ReviewPageHeading({ page, sentence }: { page: GenerationReviewPage; sentence: string }) {
  return (
    <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <ReviewChangeChip change={page.change} />
        <h2 className="min-w-0 truncate text-lg font-semibold tracking-[-0.01em] text-foreground">{page.title}</h2>
        <ReviewPagePath page={page} />
      </div>
      <p className="text-[13px] leading-5 text-pretty text-muted-foreground">{sentence}</p>
    </div>
  )
}

/** The page path on the review branch, and the generated path when a person moved the page. */
function ReviewPagePath({ page }: { page: GenerationReviewPage }) {
  const isMoved = page.branchHref !== page.href
  return (
    <span
      className="truncate font-mono text-[11.5px] text-muted-foreground max-[640px]:hidden"
      title={isMoved ? `Moved on this branch from ${page.href}, where the generation put it` : undefined}
    >
      {page.branchHref}
      {isMoved ? <span className="text-faint"> · from {page.href}</span> : null}
    </span>
  )
}

/** Reject on the left, accept on the right, each worded for this change. R and A choose them. */
function ReviewChoiceButtons({ page, decision }: { page: GenerationReviewPage; decision: ReviewDecisionControl }) {
  const copy = REVIEW_CHANGE_COPY[page.change]
  const { disabled, onDecide } = decision

  useEffect(() => {
    if (disabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
      if (isEditableTarget(event.target)) return
      const choice = event.key === "a" ? "accepted" : event.key === "r" ? "rejected" : null
      if (!choice) return
      event.preventDefault()
      onDecide(choice)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [disabled, onDecide])

  return (
    <div role="group" aria-label={`Decision for ${page.title}`} className="flex flex-wrap items-stretch gap-2">
      {decision.isSaving ? (
        <Loader2
          aria-label="Saving the decision"
          className="size-4 shrink-0 animate-spin self-center text-muted-foreground"
        />
      ) : null}
      <ChoiceButton choice={copy.reject} shortcut="R" disabled={disabled} onClick={() => onDecide("rejected")} />
      <ChoiceButton choice={copy.accept} shortcut="A" primary disabled={disabled} onClick={() => onDecide("accepted")} />
    </div>
  )
}

function ChoiceButton(props: {
  choice: ReviewChoice
  shortcut: string
  primary?: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      aria-keyshortcuts={props.shortcut}
      className={cn(
        CONTROL_HEIGHT_CLASS,
        "flex items-center gap-3 rounded-md border py-1 pr-3 pl-3.5 text-left leading-tight transition-colors disabled:pointer-events-none disabled:opacity-50",
        props.primary
          ? "border-foreground bg-foreground text-background hover:bg-foreground/85"
          : "border-border-strong bg-background text-foreground hover:bg-overlay",
      )}
    >
      <span className="flex flex-col gap-px">
        <span className="text-[13px] font-semibold">{props.choice.label}</span>
        <span className={cn("text-[11px]", props.primary ? "text-background/70" : "text-muted-foreground")}>
          {props.choice.caption}
        </span>
      </span>
      <kbd
        aria-hidden="true"
        className={cn(
          "rounded-sm border px-1.5 py-px font-mono text-[10px]",
          props.primary ? "border-background/30 text-background/70" : "border-border-strong text-muted-foreground",
        )}
      >
        {props.shortcut}
      </kbd>
    </button>
  )
}

/**
 * A decided page: what the decision does, then Change decision, which sends
 * the page back to review, and the way on to the next page to review, or to
 * the summary once every page is decided.
 */
function ReviewDecidedState(props: {
  session: ContentReviewSession
  page: GenerationReviewPage
  state: "accepted" | "rejected"
  decision: ReviewDecisionControl
  onStep: (href: string) => void
  onFinish: () => void
}) {
  const { page, state, decision } = props
  const isAccepted = state === "accepted"
  const nextHref = nextToReviewHref(props.session.pages, page.branchHref)

  return (
    <div className="flex flex-wrap items-stretch gap-2">
      <div
        role="status"
        className={cn(
          CONTROL_HEIGHT_CLASS,
          "flex items-center gap-2.5 rounded-md border py-1 pr-3.5 pl-3 leading-tight",
          isAccepted ? "border-primary/35 bg-primary/10" : "border-border-strong bg-overlay",
        )}
      >
        <ReviewDecisionMark state={state} className="size-4.5" />
        <span className="flex flex-col gap-px">
          <span className="text-[13px] font-semibold text-foreground">{REVIEW_STATE_LABEL[state]}</span>
          <span className="text-[11.5px] text-body">{reviewChoice(page, state).outcome}</span>
        </span>
      </div>
      {decision.canDecide ? (
        <Button
          type="button"
          variant="outline"
          className={cn(CONTROL_HEIGHT_CLASS, "text-[12.5px]")}
          disabled={decision.disabled}
          onClick={() => decision.onDecide("undecided")}
        >
          Change decision
        </Button>
      ) : null}
      <Button
        type="button"
        className={cn(CONTROL_HEIGHT_CLASS, "text-[12.5px] font-semibold")}
        onClick={() => (nextHref ? props.onStep(nextHref) : props.onFinish())}
      >
        {nextHref ? "Next to review" : "Finish review"}
        <ArrowRight aria-hidden="true" />
      </Button>
    </div>
  )
}

/** The pages to step through, and the pages before and after the open one. */
export type ReviewStepsState = Pick<ContentReviewSession, "pages" | "previousHref" | "nextHref">

/** The way through every page of the review, in order, as J and K do. */
function ReviewSteps(props: {
  steps: ReviewStepsState
  page: GenerationReviewPage
  onStep: (href: string) => void
}) {
  const { pages, previousHref, nextHref } = props.steps
  const position = pages.findIndex((page) => page.href === props.page.href) + 1

  return (
    <div role="group" aria-label="Review pages" className="flex items-center gap-1 border-l border-border pl-4">
      <StepButton direction="previous" href={previousHref} onStep={props.onStep} />
      <span className="min-w-14 text-center font-mono text-[11px] text-muted-foreground tabular-nums">
        {position} / {pages.length}
      </span>
      <StepButton direction="next" href={nextHref} onStep={props.onStep} />
    </div>
  )
}

function StepButton(props: { direction: "previous" | "next"; href: string | null; onStep: (href: string) => void }) {
  const isNext = props.direction === "next"
  const label = isNext ? "Next page (J)" : "Previous page (K)"
  const Icon = isNext ? ChevronDown : ChevronUp
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={props.href === null}
      onClick={() => props.href && props.onStep(props.href)}
      className={cn(TOP_BAR_ICON_BUTTON_CLASS, "disabled:pointer-events-none disabled:opacity-40")}
    >
      <Icon aria-hidden="true" />
    </button>
  )
}
