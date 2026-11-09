import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import type { GenerationJobDto } from "@doxahq/contracts"
import type { ProjectOpenPreview } from "@doxahq/contracts/project-overview"

import { SectionLabel } from "~/components/dashboard/dashboard-header"
import { Badge, type BadgeProps } from "~/components/ui/badge"

const STATUS_BADGE: Record<GenerationJobDto["status"], { label: string; variant: BadgeProps["variant"] }> = {
  queued: { label: "Queued", variant: "outline" },
  running: { label: "Running", variant: "outline" },
  succeeded: { label: "Ready", variant: "success" },
  failed: { label: "Failed", variant: "danger" },
  cancelled: { label: "Stopped", variant: "muted" },
}

function ExternalTextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-link">
      {children}
    </a>
  )
}

function PreviewRow({
  preview,
  repositoryFullName,
}: {
  preview: ProjectOpenPreview
  repositoryFullName: string | null
}) {
  const badge = STATUS_BADGE[preview.status]
  const pullRequestUrl = repositoryFullName
    ? `https://github.com/${repositoryFullName}/pull/${preview.pullRequestNumber}`
    : null

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3.5">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-[13.5px] font-medium text-foreground">
          Pull request #{preview.pullRequestNumber}
        </span>
        {preview.previewUrl || pullRequestUrl ? (
          <p className="flex flex-wrap gap-x-3 text-[13px]">
            {preview.previewUrl ? <ExternalTextLink href={preview.previewUrl}>Open preview</ExternalTextLink> : null}
            {pullRequestUrl ? <ExternalTextLink href={pullRequestUrl}>View pull request</ExternalTextLink> : null}
          </p>
        ) : null}
      </div>
      <Badge variant={badge.variant} className="shrink-0">
        {badge.label}
      </Badge>
    </div>
  )
}

/** Open pull requests and the state of their documentation previews. */
export function OpenPreviewsCard(props: {
  projectId: string
  previews: readonly ProjectOpenPreview[]
  repositoryFullName: string | null
}) {
  if (props.previews.length === 0) return null

  return (
    <section aria-labelledby="previews-title" className="flex min-w-0 flex-[2_1_18rem] flex-col gap-3">
      <div className="flex min-h-7 items-center">
        <SectionLabel>
          <span id="previews-title">Open pull request previews</span>
        </SectionLabel>
      </div>
      <ul className="surface-card">
        {props.previews.map((preview, index) => (
          <li key={preview.pullRequestNumber} className={index > 0 ? "border-t border-divider" : undefined}>
            <PreviewRow preview={preview} repositoryFullName={props.repositoryFullName} />
          </li>
        ))}
      </ul>
      <Link
        to="/dashboard/projects/$projectId/doxabot"
        params={{ projectId: props.projectId }}
        className="self-start text-[13px] text-link"
      >
        Doxabot settings
      </Link>
    </section>
  )
}
