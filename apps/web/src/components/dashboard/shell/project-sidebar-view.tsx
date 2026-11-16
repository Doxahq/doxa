import { useQuery } from "@tanstack/react-query"
import { BetaTag } from "~/components/dashboard/beta-tag"
import { Activity, Bot, ChevronRight, Info, PenLine, Settings } from "lucide-react"
import type { GenerationJobDto } from "@doxahq/contracts"

import { DoxabotIcon } from "~/components/dashboard/doxabot/doxabot-icon"
import { ProjectTitleSelect } from "~/components/dashboard/shell/project-title-select"
import { EditedPill, SidebarNavHint, SidebarNavLink } from "~/components/dashboard/shell/sidebar-nav"
import { isProjectPublished } from "~/lib/dashboard/model"
import { useOptionalProjectBranch } from "~/lib/dashboard/project-branch-context"
import { useShell } from "~/lib/dashboard/shell-context"
import { usePageSettled } from "~/lib/dashboard/use-page-settled"
import { useRenderedPathname } from "~/lib/dashboard/use-rendered-pathname"
import { approvalRequestListQueryOptions } from "~/lib/queries/approval-requests"
import { projectContentQueryOptions, projectDetailQueryOptions } from "~/lib/queries/dashboard"

/** The root sidebar view: the project's own pages. */
export function ProjectSidebarView({ projectId }: { projectId: string }) {
  const pathname = useRenderedPathname()
  const { showView } = useShell()
  const branch = useOptionalProjectBranch()
  const detail = useQuery(projectDetailQueryOptions(projectId))
  const isPublished = detail.data ? isProjectPublished(detail.data.project) : false
  // The content overview only counts the edited pages for the pill. It is a
  // slow request, so it waits until the page settles. On the content route
  // the editor has loaded it already, and the pill reads that copy at once.
  const isSettled = usePageSettled()
  const content = useQuery({
    ...projectContentQueryOptions(projectId, branch?.branchRef ?? "main"),
    enabled: isPublished && branch !== null && isSettled,
  })
  const editedCount = content.data?.working.editedHrefs.length ?? 0
  const pending = useQuery(approvalRequestListQueryOptions(projectId, "pending"))
  const pendingCount = pending.data?.requests.length ?? 0
  const base = `/dashboard/projects/${projectId}`
  const isOn = (segment: string) => pathname === `${base}/${segment}` || pathname.startsWith(`${base}/${segment}/`)

  return (
    <nav aria-label="Project" className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-3.5">
      <ProjectTitleSelect projectId={projectId} project={detail.data?.project ?? null} />
      <SidebarNavLink
        to="/dashboard/projects/$projectId/project"
        params={{ projectId }}
        icon={Info}
        label="Overview"
        active={isOn("project")}
      />
      <SidebarNavLink
        to="/dashboard/projects/$projectId/content"
        params={{ projectId }}
        icon={PenLine}
        label="Content"
        active={isOn("content")}
        // On the content route already, the link does not navigate. It still
        // slides to the Content view. From another page, the view slides when
        // the editor shows.
        onClick={isOn("content") ? () => showView("content") : undefined}
        hint={
          <>
            {editedCount > 0 ? <EditedPill count={editedCount} /> : null}
            <ChevronRight aria-hidden="true" className="size-3.5 text-faint" />
          </>
        }
      />
      <SidebarNavLink
        to="/dashboard/projects/$projectId/generations"
        params={{ projectId }}
        icon={Activity}
        label="Generations"
        active={isOn("generations")}
        hint={<LatestGenerationHint job={detail.data?.latestJob ?? null} />}
      />
      <SidebarNavLink
        to="/dashboard/projects/$projectId/doxabot"
        params={{ projectId }}
        icon={DoxabotIcon}
        label="Doxabot"
        active={isOn("doxabot")}
        hint={<BetaTag />}
      />
      <SidebarNavLink
        to="/dashboard/projects/$projectId/requests"
        params={{ projectId }}
        icon={Bot}
        label="Requests"
        active={isOn("requests")}
        hint={pendingCount > 0 ? <SidebarNavHint tone="warning">{pendingCount} pending</SidebarNavHint> : undefined}
      />
      <SidebarNavLink
        to="/dashboard/projects/$projectId/settings"
        params={{ projectId }}
        icon={Settings}
        label="Settings"
        active={isOn("settings")}
      />
    </nav>
  )
}

/** Shows the latest run only when it needs attention. */
function LatestGenerationHint({ job }: { job: GenerationJobDto | null }) {
  if (job?.status === "failed") return <SidebarNavHint tone="danger">failed</SidebarNavHint>
  if (job?.status === "cancelled") return <SidebarNavHint tone="warning">cancelled</SidebarNavHint>
  if (job?.status === "stopped_credits") return <SidebarNavHint tone="warning">out of credits</SidebarNavHint>
  if (job?.status === "running" || job?.status === "queued") {
    return <SidebarNavHint>{job.status}</SidebarNavHint>
  }
  return null
}
