import { useCallback } from "react"
import { createFileRoute } from "@tanstack/react-router"

import { ProjectContentPage } from "~/components/dashboard/content/project-content-page"
import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"
import { contentPageHrefFromSearch, startProjectPrefetch } from "~/lib/dashboard/project-route-prefetch"

interface ContentSearch {
  /** An agent's publish request to review in the publish menu (spec 12.4). */
  request?: string
  /** The href of the open page, so a reload or a shared link opens it again. */
  page?: string
  /** Opens the generation review, for example from a generation or the overview. */
  review?: true
}

export const Route = createFileRoute("/dashboard/projects/$projectId/content")({
  ...projectPagePending,
  // Starts the page's requests while its code loads, then waits for the code only.
  // A hover preload runs it each time: TanStack Query decides what is fresh.
  preloadStaleTime: 0,
  loader: (ctx) => {
    startProjectPrefetch(ctx.context.queryClient, "content", {
      projectId: ctx.params.projectId,
      contentPageHref: contentPageHrefFromSearch(ctx.location.search),
    })
    return projectPagePending.loader(ctx)
  },
  // The editor skeleton, not the spinner: the page shows the same skeleton
  // while its data loads, so the visit has one loading state.
  pendingComponent: dashboardPendingView("content"),
  validateSearch: (search: Record<string, unknown>): ContentSearch => ({
    ...(typeof search.request === "string" ? { request: search.request } : {}),
    ...(typeof search.page === "string" && search.page.startsWith("/") ? { page: search.page } : {}),
    ...(search.review === true || search.review === "true" ? { review: true as const } : {}),
  }),
  component: ProjectContentRoute,
})

function ProjectContentRoute() {
  const { projectId } = Route.useParams()
  const { request, page, review } = Route.useSearch()
  const navigate = Route.useNavigate()
  const clearRequest = useCallback(
    () => void navigate({ search: ({ request: _request, ...rest }) => rest, replace: true }),
    [navigate],
  )
  const clearReview = useCallback(
    () => void navigate({ search: ({ review: _review, ...rest }) => rest, replace: true }),
    [navigate],
  )
  // Replace, not push: switching pages does not fill the browser history.
  const showPage = useCallback(
    (href: string) => void navigate({ search: (current) => ({ ...current, page: href }), replace: true }),
    [navigate],
  )
  return (
    <ProjectContentPage
      projectId={projectId}
      approvalRequestId={request ?? null}
      onApprovalLinkOpened={clearRequest}
      pageHref={page ?? null}
      onPageShown={showPage}
      reviewRequested={review === true}
      onReviewEntryHandled={clearReview}
    />
  )
}
