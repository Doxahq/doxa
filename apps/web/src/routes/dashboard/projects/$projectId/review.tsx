import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * The old address of the generation review. A review now opens in the
 * content editor, so links in emails and bookmarks keep working.
 */
export const Route = createFileRoute("/dashboard/projects/$projectId/review")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/dashboard/projects/$projectId/content",
      params: { projectId: params.projectId },
      search: { review: true },
      replace: true,
    })
  },
})
