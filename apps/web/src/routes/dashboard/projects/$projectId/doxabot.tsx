import { createFileRoute, redirect } from "@tanstack/react-router"

// Doxabot moved into the project Settings page. The old URL keeps working.
export const Route = createFileRoute("/dashboard/projects/$projectId/doxabot")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/dashboard/projects/$projectId/settings",
      params: { projectId: params.projectId },
      replace: true,
    })
  },
})
