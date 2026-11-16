import { useCallback, useState } from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"

import { DashboardHeader, PageBody, PageHeading } from "~/components/dashboard/dashboard-header"
import { CreateProjectDialog } from "~/components/dashboard/new-project/create-project-dialog"
import { GenerateFromRepositoryDialog } from "~/components/dashboard/new-project/generate-from-repository-dialog"
import { FreePlanStrip } from "~/components/dashboard/new-project/free-plan-strip"
import { McpConnectCard } from "~/components/dashboard/new-project/mcp-connect-card"
import { StartProjectCard } from "~/components/dashboard/new-project/start-project-card"
import { TrialStartedNotice } from "~/components/dashboard/new-project/trial-started-notice"
import { PRO_REASON_REPOSITORY } from "~/lib/dashboard/ai-access"
import { NEW_PROJECT_TRIAL_RETURN_PATH, type NewProjectStart } from "~/lib/dashboard/new-project-search"
import { useProGate } from "~/lib/dashboard/pro-trial-dialog"
import { useNewProjectAiAccess } from "~/lib/dashboard/use-ai-access"
import { useProjectsSummary } from "~/lib/dashboard/use-projects-summary"
import { useTrialStartedNotice } from "~/lib/dashboard/use-trial-started-notice"

/**
 * The new project page, and the onboarding screen of a user with no project:
 * generate docs from a GitHub repository, create a project from the starter
 * docs or an empty site, or connect an agent through MCP.
 *
 * `?start=repository` or `?start=template` opens that dialog on arrival.
 * `?checkout=<id>` is the return of the Pro trial's Checkout: once the trial
 * is on, that visit shows "Your Pro trial started" above the heading.
 *
 * With billing on, an account without the Doxa Agent (Free) sees the same
 * options, a PRO tag on "Generate from a repository" and a strip at the end
 * that says what Free has. A click on that button opens the Pro trial dialog
 * (`useProGate`), and the repository dialog never opens for it. With billing off, every option works as before.
 */
export function NewProjectPage() {
  const navigate = useNavigate()
  const search = useSearch({ from: "/dashboard/projects/new" })
  const { projects, isPending } = useProjectsSummary()
  const isFirstProject = !isPending && projects.length === 0
  const [dialog, setDialog] = useState<NewProjectStart | null>(search.start ?? null)
  // The Pro trial's Checkout returns here with `?checkout=<id>&start=repository`:
  // the sync runs once, the parameter goes, and the repository dialog opens
  // once the plan has the Doxa Agent (the card holds its reserved state until then).
  const start = search.start
  const clearCheckout = useCallback(() => {
    void navigate({ to: "/dashboard/projects/new", search: start ? { start } : {}, replace: true })
  }, [navigate, start])
  const aiAccess = useNewProjectAiAccess({ sessionId: search.checkout ?? null, onHandled: clearCheckout })
  const proGate = useProGate(aiAccess)
  const trialNotice = useTrialStartedNotice(search.checkout ?? null, aiAccess)
  // Opens once the plan is known, so a Free account never sees it flash.
  const canGenerate = aiAccess.kind === "open"

  function openDialog(next: NewProjectStart | null) {
    setDialog(next)
    // The dialog that opened on arrival is not opened again by a reload.
    if (search.start) void navigate({ to: "/dashboard/projects/new", search: {}, replace: true })
  }

  /** Free: the Pro trial dialog, and Checkout comes back here to open the repository dialog. */
  function generateFromRepository() {
    if (proGate(PRO_REASON_REPOSITORY, NEW_PROJECT_TRIAL_RETURN_PATH)) {
      setDialog(null)
      return
    }
    openDialog("repository")
  }

  return (
    <>
      <DashboardHeader title="New project" />

      <PageBody className="gap-10">
        <TrialStartedNotice state={trialNotice} />
        <PageHeading
          label={isFirstProject ? "Welcome to Doxa" : "New project"}
          title={isFirstProject ? "Create your first docs project" : "Create a docs project"}
          description="A project is one docs site. It holds your pages, theme, navigation and domain. Create one here, or let your agent create it for you through MCP."
        />
        <StartProjectCard
          isFirstProject={isFirstProject}
          access={aiAccess}
          onGenerateFromRepository={generateFromRepository}
          onCreateProject={() => openDialog("template")}
        />
        <McpConnectCard />
        {aiAccess.kind === "needs_pro" ? <FreePlanStrip /> : null}
      </PageBody>

      <GenerateFromRepositoryDialog
        open={dialog === "repository" && canGenerate}
        onOpenChange={(open) => openDialog(open ? "repository" : null)}
        onStartWithoutRepository={() => openDialog("template")}
      />
      <CreateProjectDialog
        open={dialog === "template"}
        onOpenChange={(open) => openDialog(open ? "template" : null)}
        onGenerateFromRepository={aiAccess.kind === "loading" ? null : generateFromRepository}
      />
    </>
  )
}
