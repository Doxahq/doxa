import type { GenerationChangedPage } from "@doxahq/contracts/generation-reviews"

import { reviewPageEvidence } from "~/lib/dashboard/generation-review-model"

/**
 * The files the writer read, and the statements of the hand-written page
 * that the source contradicts. Each conflict is worth a look before publish.
 */
export function ReviewPageEvidence({ page }: { page: GenerationChangedPage }) {
  const evidence = reviewPageEvidence(page)
  if (evidence.sources.length === 0 && evidence.conflicts.length === 0) return null

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-2.5">
      {evidence.conflicts.length > 0 ? (
        <div className="border-l-2 border-warning pl-3">
          <p className="text-xs font-medium text-warning">Your page disagrees with the code</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-body">
            {evidence.conflicts.map((conflict) => <li key={conflict}>{conflict}</li>)}
          </ul>
        </div>
      ) : null}
      {evidence.sources.length > 0 ? (
        <p
          className="line-clamp-2 break-words font-mono text-[11px] text-muted-foreground sm:line-clamp-none sm:truncate"
          title={evidence.sources.join("\n")}
        >
          Based on: {evidence.sources.join(", ")}
        </p>
      ) : null}
    </div>
  )
}
