import { createFileRoute } from "@tanstack/react-router"

import { NewProjectPage } from "~/components/dashboard/new-project-page"
import { parseNewProjectSearch } from "~/lib/dashboard/new-project-search"

export const Route = createFileRoute("/dashboard/projects/new")({
  validateSearch: parseNewProjectSearch,
  component: NewProjectPage,
})
