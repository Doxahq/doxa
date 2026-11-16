import { Link } from "@tanstack/react-router"

import { FREE_PLAN_NOTE } from "~/lib/dashboard/free-plan-note"

/** A quiet strip at the end of the new project page, on Free only: what Free has, and a link to compare plans. */
export function FreePlanStrip() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-card px-4 py-3 text-[13px] leading-5 text-muted-foreground">
      <p className="flex-[1_1_18rem]">{FREE_PLAN_NOTE}</p>
      <Link to="/dashboard/billing" className="text-primary-text underline-offset-4 hover:underline">
        Compare plans
      </Link>
    </div>
  )
}
