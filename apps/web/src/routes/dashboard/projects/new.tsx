import { createFileRoute } from "@tanstack/react-router"

import { NewProjectPage } from "~/components/dashboard/new-project-page"

export const Route = createFileRoute("/dashboard/projects/new")({
  component: NewProjectPage,
})
