import { createFileRoute } from "@tanstack/react-router"

import { ProjectsPage } from "~/components/dashboard/projects-page"

export const Route = createFileRoute("/dashboard/projects/")({
  component: ProjectsPage,
})
