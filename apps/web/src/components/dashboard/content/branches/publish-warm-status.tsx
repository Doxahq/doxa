import { useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { publishWarmJob, warmProgress, warmRegionsText } from "~/lib/dashboard/docs-warm-status"
import { docsWarmStatusQueryOptions } from "~/lib/queries/docs-warm-status"

/**
 * One status line under a finished publish: how far the regional warm job got
 * (M45b). It renders nothing until the first answer, and nothing when the
 * status is unknown, so the menu never shows a spinner for it.
 */
export function PublishWarmStatus({ projectId, docsUrl }: { projectId: string; docsUrl: string | null }) {
  // Mounted when the publish answer arrives, so this is the publish's time.
  const [publishedAt] = useState(() => Date.now())
  const { data } = useQuery(docsWarmStatusQueryOptions(projectId, publishedAt))
  const job = data ? publishWarmJob(data, publishedAt) : null
  if (!data || !job) return null

  const progress = warmProgress(job, data.clientRegion)
  const lineClass = "mt-4 font-mono text-[11px] leading-5 tracking-[0.14em] text-muted-foreground uppercase"

  if (progress.ownRegion === "warming") {
    return (
      <p role="status" className={lineClass}>
        Warming your region…
        {docsUrl ? (
          <>
            {" · "}
            <a
              href={docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline-offset-4 hover:underline focus-visible:underline"
            >
              View now
            </a>
          </>
        ) : null}
      </p>
    )
  }

  return (
    <p role="status" className={lineClass}>
      {progress.ownRegion === "done" ? (
        <>
          <span className="text-success">Live in your region</span>
          {" · "}
          {warmRegionsText(progress)}
        </>
      ) : progress.ownRegion === "failed" ? (
        // The site is live; only the pre-warm of this region did not finish.
        <>
          <span className="text-warning">Your region was not pre-warmed</span>
          {" · "}
          {warmRegionsText(progress)}
        </>
      ) : (
        capitalize(warmRegionsText(progress))
      )}
    </p>
  )
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
