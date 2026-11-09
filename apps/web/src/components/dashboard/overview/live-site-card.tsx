import type { ProjectDto } from "@doxahq/contracts"
import type { ProjectLatestPublication } from "@doxahq/contracts/project-overview"
import { ExternalLink } from "lucide-react"

import { FIELD_LABEL_CLASS } from "~/components/dashboard/dashboard-header"
import { RelativeDate } from "~/components/dashboard/exact-date-tooltip"
import { SitePreviewArt } from "~/components/dashboard/overview/site-preview-art"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"

const SHORT_REVISION_LENGTH = 7

function hostOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function PublicationNote({ publication, isLive }: { publication: ProjectLatestPublication | null; isLive: boolean }) {
  if (!isLive || !publication) return <>Your site goes live after the first generation.</>
  const age = <RelativeDate date={publication.publishedAt} />
  if (publication.kind === "starter") return <>Example pages published {age}.</>
  return (
    <>
      Version {publication.versionNumber} published {age} by {publication.actor.name}.
    </>
  )
}

/** What a visitor gets, where it comes from, and how fresh it is. */
export function LiveSiteCard(props: {
  project: ProjectDto
  latestPublication: ProjectLatestPublication | null
  lastSyncedRevision: string | null
  productionBranch: string | null
  defaultHostname: string | null
}) {
  const { project } = props
  const isLive = project.publishedVersionId !== null
  const host = hostOf(project.docsUrl)
  const facts = [
    { label: "Repository", value: project.repositoryFullName },
    { label: "Production branch", value: props.productionBranch },
    { label: "Last synced commit", value: props.lastSyncedRevision?.slice(0, SHORT_REVISION_LENGTH) ?? null },
    { label: "Default address", value: props.defaultHostname === host ? null : props.defaultHostname },
  ].filter((fact) => fact.value)

  return (
    <section aria-label="Live site" className="surface-card flex flex-col overflow-hidden lg:flex-row">
      <div className="min-w-0 flex-1 border-b border-divider bg-sidebar pt-6 pl-6 lg:border-r lg:border-b-0">
        <SitePreviewArt address={host} title={project.name} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-5 p-6">
        <div className="flex flex-col gap-2">
          <Badge variant={isLive ? "success" : "muted"} className="self-start">
            {isLive ? <span aria-hidden="true" className="size-1.5 rounded-full bg-success" /> : null}
            {isLive ? "Live" : "Not published"}
          </Badge>
          {isLive && project.docsUrl ? (
            <a
              href={project.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-w-0 items-center gap-2 self-start text-xl font-semibold tracking-[-0.01em] text-foreground"
            >
              <span className="truncate">{host}</span>
              <ExternalLink aria-hidden="true" className="size-4 shrink-0 text-label" />
            </a>
          ) : (
            <p className="truncate text-xl font-semibold tracking-[-0.01em] text-foreground">{host ?? project.slug}</p>
          )}
          <p className="text-sm text-muted-foreground">
            <PublicationNote publication={props.latestPublication} isLive={isLive} />
          </p>
        </div>

        {facts.length > 0 ? (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
            {facts.map((fact) => (
              <div key={fact.label} className="flex min-w-0 flex-col gap-1">
                <dt className={FIELD_LABEL_CLASS}>{fact.label}</dt>
                <dd className="truncate font-mono text-[13px] text-foreground">{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {isLive && project.docsUrl ? (
          <div className="mt-auto">
            <Button variant="outline" size="sm" asChild>
              <a href={project.docsUrl} target="_blank" rel="noopener noreferrer">
                Open site
              </a>
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
