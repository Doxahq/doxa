import { Link } from "@tanstack/react-router"

import { Button } from "~/components/ui/button"
import { FREE_PLAN_NOTE } from "~/lib/dashboard/free-plan-note"

/** Another workspace of the viewer where a new project gets the Doxa Agent. */
export interface ProWorkspaceOffer {
  readonly name: string
  readonly onSwitch: () => void
}

/**
 * A quiet strip at the end of the new project page, on Free only: what Free
 * has, and a link to compare plans. When another workspace of the viewer is
 * on Pro, it says so and switches there in one click.
 */
export function FreePlanStrip({ proWorkspace }: { proWorkspace: ProWorkspaceOffer | null }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-card px-4 py-3 text-[13px] leading-5 text-muted-foreground">
      <p className="flex-[1_1_18rem]">
        <span>{FREE_PLAN_NOTE}</span>
        {proWorkspace ? <span className="text-foreground"> {proWorkspace.name} has Pro.</span> : null}
      </p>
      {proWorkspace ? (
        <Button variant="outline" size="sm" onClick={proWorkspace.onSwitch}>
          Switch to {proWorkspace.name}
        </Button>
      ) : null}
      <Link to="/dashboard/billing" className="text-primary-text underline-offset-4 hover:underline">
        Compare plans
      </Link>
    </div>
  )
}
