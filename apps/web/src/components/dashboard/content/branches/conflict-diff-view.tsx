import { useQuery } from "@tanstack/react-query"
import type { BranchRef, DocsConflict } from "@doxahq/contracts/docs-branches"

import { Skeleton } from "~/components/ui/skeleton"
import { getErrorMessage } from "~/lib/errors"
import { docsConflictDiffQueryOptions } from "~/lib/queries/docs-branches"

export function ConflictDiffView(props: {
  projectId: string
  branch: BranchRef
  conflict: DocsConflict
}) {
  const query = useQuery(docsConflictDiffQueryOptions(
    props.projectId,
    props.branch,
    props.conflict.key,
  ))

  if (query.isPending) return <Skeleton className="h-40 w-full" />
  if (query.error) {
    return (
      <p className="text-sm text-destructive">
        {getErrorMessage(query.error, "The comparison could not be loaded.")}
      </p>
    )
  }
  if (!query.data) return null

  return (
    <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border lg:grid-cols-3">
      <DiffColumn label="Base" value={query.data.base} />
      <DiffColumn label="Main" value={query.data.main} />
      <DiffColumn label="Mine" value={query.data.mine} />
    </div>
  )
}

function DiffColumn(props: { label: string; value: unknown }) {
  const value = typeof props.value === "string" || props.value === null
    ? (props.value ?? "Deleted")
    : JSON.stringify(props.value, null, 2)

  return (
    <section className="min-w-0 bg-background">
      <h4 className="border-b border-border px-3 py-2 font-mono text-[10px] uppercase text-label">
        {props.label}
      </h4>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap p-3 font-mono text-[11px] leading-5">
        {value}
      </pre>
    </section>
  )
}
