import { useState } from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"

import { DashboardHeader, PageBody, PageHeading } from "~/components/dashboard/dashboard-header"
import { CreateProjectDialog } from "~/components/dashboard/new-project/create-project-dialog"
import { GenerateFromRepositoryDialog } from "~/components/dashboard/new-project/generate-from-repository-dialog"
import { McpConnectCard } from "~/components/dashboard/new-project/mcp-connect-card"
import { StartProjectCard } from "~/components/dashboard/new-project/start-project-card"
import type { NewProjectStart } from "~/lib/dashboard/new-project-search"
import { useProjectsSummary } from "~/lib/dashboard/use-projects-summary"

/**
 * The new project page, and the onboarding screen of a user with no project:
 * generate docs from a GitHub repository, create a project from the starter
 * docs or an empty site, or connect an agent through MCP.
 *
 * `?start=repository` or `?start=template` opens that dialog on arrival.
 */
export function NewProjectPage() {
  const navigate = useNavigate()
  const search = useSearch({ from: "/dashboard/projects/new" })
  const { projects, isPending } = useProjectsSummary()
  const isFirstProject = !isPending && projects.length === 0
  const [dialog, setDialog] = useState<NewProjectStart | null>(search.start ?? null)

  function openDialog(next: NewProjectStart | null) {
    setDialog(next)
    // The dialog that opened on arrival is not opened again by a reload.
    if (search.start) void navigate({ to: "/dashboard/projects/new", search: {}, replace: true })
  }

  return (
    <>
      <DashboardHeader title="New project" />

      <PageBody className="gap-10">
        <PageHeading
          label={isFirstProject ? "Welcome to Doxa" : "New project"}
          title={isFirstProject ? "Create your first docs project" : "Create a docs project"}
          description="A project is one docs site. It holds your pages, theme, navigation and domain. Create one here, or let your agent create it for you through MCP."
        />
        <StartProjectCard
          isFirstProject={isFirstProject}
          onGenerateFromRepository={() => openDialog("repository")}
          onCreateProject={() => openDialog("template")}
        />
        <McpConnectCard />
      </PageBody>

      <GenerateFromRepositoryDialog
        open={dialog === "repository"}
        onOpenChange={(open) => openDialog(open ? "repository" : null)}
        onStartWithoutRepository={() => openDialog("template")}
      />
      <CreateProjectDialog
        open={dialog === "template"}
        onOpenChange={(open) => openDialog(open ? "template" : null)}
        onGenerateFromRepository={() => openDialog("repository")}
      />
    </>
  )
}
