import { Link } from "@tanstack/react-router"
import type { GenerationDetailDto } from "@doxahq/contracts"
import { ExternalLink, GitPullRequestArrow, History } from "lucide-react"

import { REVIEW_STRIP_CLASS } from "~/components/dashboard/content/review/review-banner"
import { Button } from "~/components/ui/button"
import { shortenGenerationId } from "~/lib/dashboard/generation-model"
import { cn } from "~/lib/utils"

/**
 * Says that the page shows the changes of a pull request preview, that
 * nobody decides on them here, and when they will be reviewed: after the
 * merge, in the review of the production run. It wears the review strip.
 */
export function ChangesBanner(props: {
  projectId: string
  generationId: string
  /** Null until the generation loads, or for a run without a pull request. */
  pullRequest: GenerationDetailDto["source"]["changeProposal"]
  previewUrl: string | null
}) {
  const generationLink = {
    to: "/dashboard/projects/$projectId/generations/$generationId",
    params: { projectId: props.projectId, generationId: props.generationId },
  } as const

  return (
    <div
      role="region"
      aria-label="Pull request changes"
      className={cn(REVIEW_STRIP_CLASS, "lg:flex-row lg:items-center lg:justify-between")}
    >
      <div className="flex min-w-0 items-start gap-3">
        <GitPullRequestArrow aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary-text" />
        <div className="flex min-w-0 flex-col">
          <p className="text-sm font-medium text-foreground">
            {props.pullRequest ? `Changes of pull request #${props.pullRequest.number}` : "Changes of a pull request"}
            {" · generation "}
            <Link
              {...generationLink}
              title="View generation"
              className="font-mono text-[13px] text-primary-text underline-offset-2 hover:underline focus-visible:underline"
            >
              {shortenGenerationId(props.generationId)}
            </Link>
          </p>
          <p className="text-[13px] leading-5 text-pretty text-muted-foreground">
            Read only. When the pull request merges, Doxa updates your docs in a new generation, and you review its
            changes before they go live.
          </p>
        </div>
      </div>
      {/* On a phone the links show only their icons, so the actions keep one line. */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 pl-7 lg:pl-0">
        <Button variant="ghost" size="sm" asChild>
          <Link {...generationLink}>
            <History aria-hidden="true" />
            <span className="max-sm:sr-only">View generation</span>
          </Link>
        </Button>
        {props.previewUrl ? (
          <Button variant="outline" size="sm" asChild>
            <a href={props.previewUrl} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden="true" />
              <span className="max-sm:sr-only">Open preview</span>
            </a>
          </Button>
        ) : null}
      </div>
    </div>
  )
}
