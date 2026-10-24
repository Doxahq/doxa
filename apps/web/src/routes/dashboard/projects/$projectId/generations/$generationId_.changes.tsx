import { useCallback } from "react"
import { createFileRoute } from "@tanstack/react-router"

import { GenerationChangesPage } from "~/components/dashboard/generation-changes/generation-changes-page"
import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"

interface ChangesSearch {
  /** The href of the open page, so a reload or a shared link opens it again. */
  page?: string
}

export const Route = createFileRoute("/dashboard/projects/$projectId/generations/$generationId_/changes")({
  ...projectPagePending,
  // The page's own shape, not the spinner: the page shows it too while its data loads.
  pendingComponent: dashboardPendingView("generationChanges"),
  validateSearch: (search: Record<string, unknown>): ChangesSearch =>
    typeof search.page === "string" && search.page.startsWith("/") ? { page: search.page } : {},
  component: GenerationChangesRoute,
})

function GenerationChangesRoute() {
  const { projectId, generationId } = Route.useParams()
  const { page } = Route.useSearch()
  const navigate = Route.useNavigate()
  // Replace, not push: stepping through pages does not fill the browser history.
  const showPage = useCallback(
    (href: string) => void navigate({ search: { page: href }, replace: true }),
    [navigate],
  )
  return (
    <GenerationChangesPage projectId={projectId} generationId={generationId} pageHref={page ?? null} onPageShown={showPage} />
  )
}
