import type { ReferenceSourceReport } from "@doxahq/contracts"
import { AlertTriangle } from "lucide-react"

import { specProblemNotice } from "~/lib/dashboard/reference-source"

/**
 * The API spec problems of a run: spec files that could not be used, files
 * that did not parse with their line and column, and operations that were
 * left out. Nothing shows when the spec was read cleanly or there is none.
 */
export function GenerationSpecProblems(props: { report: ReferenceSourceReport | null }) {
  const notice = specProblemNotice(props.report)
  if (!notice) return null

  return (
    <section aria-label="API spec problems" className="flex flex-col gap-3 rounded-md border border-warning/35 bg-warning/10 p-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-warning" />
          {notice.heading}
        </div>
        <p className="text-xs text-muted-foreground">{notice.summary}</p>
      </div>
      <ul className="flex flex-col gap-2">
        {notice.problems.map((problem, index) => (
          <li key={`${problem.path}:${problem.operation ?? ""}:${index}`} className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="min-w-0 break-all font-mono text-[12.5px] text-foreground">{problem.path}</span>
              {problem.location ? (
                <span className="shrink-0 font-mono text-[10.5px] tracking-[0.08em] text-label uppercase">
                  {problem.location}
                </span>
              ) : null}
              {problem.operation ? (
                <span className="min-w-0 break-all font-mono text-[10.5px] tracking-[0.08em] text-label">
                  {problem.operation}
                </span>
              ) : null}
            </span>
            <span className="break-words text-xs text-muted-foreground">{problem.message}</span>
          </li>
        ))}
      </ul>
      {notice.unlistedOperationCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          {notice.unlistedOperationCount === 1
            ? "1 more operation was left out."
            : `${notice.unlistedOperationCount} more operations were left out.`}
        </p>
      ) : null}
    </section>
  )
}
