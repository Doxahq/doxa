import { createFileRoute, redirect } from "@tanstack/react-router"

// Domains moved into Site settings. The old URL keeps working.
export const Route = createFileRoute("/dashboard/projects/$projectId/domains")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/dashboard/projects/$projectId/site/domains",
      params: { projectId: params.projectId },
      replace: true,
    })
  },
})
