import { Link } from "@tanstack/react-router"
import { Check } from "lucide-react"

import { Bar, TextBar } from "~/components/dashboard/skeletons/skeleton-kit"
import { Button } from "~/components/ui/button"
import type { TrialStartedNotice as TrialStartedNoticeState } from "~/lib/dashboard/trial-started-notice"
import { cn } from "~/lib/utils"

const ROOT_CLASS = "flex flex-wrap items-center gap-3 rounded-lg px-4 py-3.5"
const TEXT_CLASS = "flex min-w-0 flex-[1_1_16rem] flex-col gap-0.5"
const TITLE_CLASS = "text-sm leading-5 font-semibold"
const LINE_CLASS = "text-[13px] leading-5"

/**
 * "Your Pro trial started", above the new project page's heading on the
 * Checkout return: a success tint, never a colored border stripe. While the
 * page waits for the plan, a notice-shaped bar holds its place, so the page
 * keeps its shape.
 */
export function TrialStartedNotice({ state }: { state: TrialStartedNoticeState }) {
  if (state.kind === "none") return null
  if (state.kind === "pending") return <TrialStartedNoticeSkeleton />
  return (
    <div role="status" className={cn(ROOT_CLASS, "bg-success/8")}>
      <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-md bg-success/14 text-success">
        <Check className="size-4" />
      </span>
      <div className={TEXT_CLASS}>
        <p className={cn(TITLE_CLASS, "text-foreground")}>Your Pro trial started</p>
        <p className={cn(LINE_CLASS, "text-muted-foreground")}>{state.line}</p>
      </div>
      <Button variant="ghost" size="sm" asChild>
        <Link to="/dashboard/billing">View billing</Link>
      </Button>
    </div>
  )
}

function TrialStartedNoticeSkeleton() {
  return (
    <div aria-hidden="true" className={cn(ROOT_CLASS, "bg-card")}>
      <Bar width="1.75rem" height="1.75rem" className="rounded-md" />
      <div className={TEXT_CLASS}>
        <TextBar width="10rem" className={TITLE_CLASS} />
        <TextBar width="22rem" className={LINE_CLASS} />
        {/* The line takes two rows on a phone. */}
        <TextBar width="8rem" className={cn(LINE_CLASS, "sm:hidden")} />
      </div>
      <Bar width="6.5rem" height="2rem" />
    </div>
  )
}
