import type { DocsBranchStatus } from "@doxahq/contracts/docs-branches"
import { GitCompareArrows } from "lucide-react"

import { ExactDateTooltip } from "~/components/dashboard/exact-date-tooltip"
import { Button } from "~/components/ui/button"

export function BranchStatusBanner(props: {
  status: DocsBranchStatus
  /** Null for a role without `docs.write`: the banner only informs. */
  onSynchronize: (() => void) | null
}) {
  if (!props.status.behind) return null

  const text = props.status.branch.kind === "hidden"
    ? "Main changed while you edited. Synchronize to get the latest main."
    : <NamedBranchMessage status={props.status} />

  return (
    <div
      role="status"
      className={[
        "flex flex-col gap-3 rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 text-warning",
        "sm:flex-row sm:items-center sm:justify-between",
      ].join(" ")}
    >
      <p className="text-sm leading-6">{text}</p>
      {props.onSynchronize ? (
        <Button type="button" variant="outline" size="sm" onClick={props.onSynchronize}>
          <GitCompareArrows aria-hidden="true" />
          Synchronize
        </Button>
      ) : null}
    </div>
  )
}

function NamedBranchMessage({ status }: { status: DocsBranchStatus }) {
  const count = status.publicationsSinceBase
  const publicationWord = count === 1 ? "publication" : "publications"
  const latest = status.main.latestPublication
  return (
    <>
      Main changed since this branch started: {count} new {publicationWord}. The latest is {articleFor(latest.kind)}{" "}
      {latest.kind}, <ExactDateTooltip date={latest.createdAt}>{relativeTime(latest.createdAt)}</ExactDateTooltip>.
      Synchronize to get the latest main.
    </>
  )
}

function articleFor(value: string): "an" | "a" {
  return /^[aeiou]/i.test(value) ? "an" : "a"
}

function relativeTime(value: string): string {
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1_000))
  if (elapsedSeconds < 60) return "a few seconds ago"
  const minutes = Math.round(elapsedSeconds / 60)
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? "day" : "days"} ago`
}
