import { useCallback, useState } from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"

import { DashboardHeader, EmptyState, PageBody, PageHeading } from "~/components/dashboard/dashboard-header"
import { CreateProjectDialog } from "~/components/dashboard/new-project/create-project-dialog"
import { GenerateFromRepositoryDialog } from "~/components/dashboard/new-project/generate-from-repository-dialog"
import { FreePlanStrip, type ProWorkspaceOffer } from "~/components/dashboard/new-project/free-plan-strip"
import { McpConnectCard } from "~/components/dashboard/new-project/mcp-connect-card"
import { NewProjectWorkspaceButton } from "~/components/dashboard/new-project/new-project-workspace-button"
import { StartProjectCard } from "~/components/dashboard/new-project/start-project-card"
import { TrialStartedNotice } from "~/components/dashboard/new-project/trial-started-notice"
import { Button } from "~/components/ui/button"
import { AI_ACCESS_LOADING, PRO_REASON_REPOSITORY, planHasDoxaAgent } from "~/lib/dashboard/ai-access"
import { NEW_PROJECT_TRIAL_RETURN_PATH, type NewProjectStart } from "~/lib/dashboard/new-project-search"
import { useProGate } from "~/lib/dashboard/pro-trial-dialog"
import { TEAM_ROLE_LABELS } from "~/lib/dashboard/teams-model"
import { useNewProjectAiAccess } from "~/lib/dashboard/use-ai-access"
import { useProjectsSummary } from "~/lib/dashboard/use-projects-summary"
import { useTrialStartedNotice } from "~/lib/dashboard/use-trial-started-notice"
import { useWorkspace } from "~/lib/dashboard/workspace-context"
import {
  canCreateProjectIn,
  PERSONAL_WORKSPACE_ID,
  type Workspace,
  type WorkspaceId,
} from "~/lib/dashboard/workspace-model"

/**
 * The new project page, and the onboarding screen of a user with no project:
 * generate docs from a GitHub repository, create a project from the starter
 * docs or an empty site, or connect an agent through MCP.
 *
 * `?start=repository` or `?start=template` opens that dialog on arrival.
 * `?checkout=<id>` is the return of the Pro trial's Checkout: once the trial
 * is on, that visit shows "Your Pro trial started" above the heading.
 *
 * The project belongs to the current workspace (Personal or a team), which
 * the top bar names and changes. A team role without `project.create`
 * (editor, viewer) sees why it cannot create one, and the way to Personal.
 *
 * With billing on, a workspace without the Doxa Agent (Free) sees the same
 * options, a PRO tag on "Generate from a repository" and a strip at the end
 * that says what Free has, and names another workspace on Pro. A click on
 * that button opens the Pro trial dialog (`useProGate`), and the repository
 * dialog never opens for it. With billing off, every option works as before.
 */
export function NewProjectPage() {
  const navigate = useNavigate()
  const search = useSearch({ from: "/dashboard/projects/new" })
  const { projects, isPending } = useProjectsSummary()
  const { current, workspaces, switchTo } = useWorkspace()
  const isFirstProject = !isPending && projects.length === 0
  const creation = projectCreation(current)
  const [dialog, setDialog] = useState<NewProjectStart | null>(search.start ?? null)
  // The Pro trial's Checkout returns here with `?checkout=<id>&start=repository`:
  // the sync runs once, the parameter goes, and the repository dialog opens
  // once the plan has the Doxa Agent (the card holds its reserved state until then).
  const start = search.start
  const clearCheckout = useCallback(() => {
    void navigate({ to: "/dashboard/projects/new", search: start ? { start } : {}, replace: true })
  }, [navigate, start])
  const workspaceAccess = useNewProjectAiAccess(current, { sessionId: search.checkout ?? null, onHandled: clearCheckout })
  // The role decides first: until it is known, the card keeps its reserved state.
  const aiAccess = creation === "allowed" ? workspaceAccess : AI_ACCESS_LOADING
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

  const teamId = current?.teamId ?? null
  const proWorkspace = aiAccess.kind === "needs_pro" ? proWorkspaceOffer(workspaces, current, switchTo) : null

  return (
    <>
      <DashboardHeader title="New project" actions={<NewProjectWorkspaceButton />} />

      <PageBody className="gap-10">
        <TrialStartedNotice state={trialNotice} />
        <PageHeading
          label={isFirstProject ? "Welcome to Doxa" : "New project"}
          title={isFirstProject ? "Create your first docs project" : "Create a docs project"}
          description="A project is one docs site. It holds your pages, theme, navigation and domain. Create one here, or let your agent create it for you through MCP."
        />
        {creation === "denied" && current ? (
          <RoleCannotCreate workspace={current} onSwitchToPersonal={() => switchTo(PERSONAL_WORKSPACE_ID)} />
        ) : (
          <StartProjectCard
            isFirstProject={isFirstProject}
            access={aiAccess}
            onGenerateFromRepository={generateFromRepository}
            onCreateProject={() => openDialog("template")}
          />
        )}
        <McpConnectCard />
        {aiAccess.kind === "needs_pro" ? <FreePlanStrip proWorkspace={proWorkspace} /> : null}
      </PageBody>

      <GenerateFromRepositoryDialog
        open={dialog === "repository" && canGenerate}
        teamId={teamId}
        onOpenChange={(open) => openDialog(open ? "repository" : null)}
        onStartWithoutRepository={() => openDialog("template")}
      />
      {/* A project is created only once its workspace is known, never in Personal by default. */}
      <CreateProjectDialog
        open={dialog === "template" && creation === "allowed"}
        teamId={teamId}
        onOpenChange={(open) => openDialog(open ? "template" : null)}
        onGenerateFromRepository={aiAccess.kind === "loading" ? null : generateFromRepository}
      />
    </>
  )
}

type ProjectCreation = "pending" | "allowed" | "denied"

/** Pending while the workspace or the viewer's team role is not known yet. */
function projectCreation(workspace: Workspace | null): ProjectCreation {
  if (!workspace || workspace.role === null) return "pending"
  return canCreateProjectIn(workspace) ? "allowed" : "denied"
}

/**
 * On Free: another workspace of the viewer where a new project has the Doxa
 * Agent (trial or Pro) and the viewer can create one, if any.
 */
function proWorkspaceOffer(
  workspaces: readonly Workspace[],
  current: Workspace | null,
  switchTo: (workspaceId: WorkspaceId) => void,
): ProWorkspaceOffer | null {
  const pro = workspaces.find(
    (workspace) =>
      workspace.id !== current?.id &&
      canCreateProjectIn(workspace) &&
      workspace.billingAccount !== null &&
      planHasDoxaAgent(workspace.billingAccount.plan),
  )
  return pro ? { name: pro.name, onSwitch: () => switchTo(pro.id) } : null
}

/** An editor or viewer of a team: owners and admins create the team's projects. */
function RoleCannotCreate({ workspace, onSwitchToPersonal }: { workspace: Workspace; onSwitchToPersonal: () => void }) {
  const role = workspace.role ? TEAM_ROLE_LABELS[workspace.role].toLowerCase() : "member"
  const article = /^[aeiou]/.test(role) ? "an" : "a"
  return (
    <EmptyState
      title="Owners and admins create projects"
      description={`You are ${article} ${role} in ${workspace.name}. Ask an owner or admin to create the project, or create one in your personal workspace.`}
      action={
        <Button variant="outline" onClick={onSwitchToPersonal}>
          Switch to Personal
        </Button>
      }
    />
  )
}
