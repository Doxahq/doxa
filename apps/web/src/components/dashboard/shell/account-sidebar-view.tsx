import { useNavigate } from "@tanstack/react-router"
import { Coins, CreditCard, UserRound, Users } from "lucide-react"

import { UserRow } from "~/components/dashboard/shell/sidebar-footer"
import { SidebarNavLink, SidebarSectionLabel } from "~/components/dashboard/shell/sidebar-nav"
import { SidebarViewFooter, SidebarViewHeader } from "~/components/dashboard/shell/sidebar-view-stack"
import { useProjectsSummary } from "~/lib/dashboard/use-projects-summary"
import { useRenderedPathname } from "~/lib/dashboard/use-rendered-pathname"
import { useWorkspace } from "~/lib/dashboard/workspace-context"
import { canReadBillingOf } from "~/lib/dashboard/workspace-model"

const PLAN_PAGE = /^\/dashboard\/billing(?:\/[^/]+)?\/?$/
const CREDITS_PAGE = /^\/dashboard\/billing\/[^/]+\/credits\/?$/

/**
 * The Account sidebar view: Account settings, Teams, and the billing pages of
 * the current workspace's account (Personal or a team), when the viewer's
 * role can read it. It slides in like Site settings, and its back button
 * returns to the shell's project (the last opened one in the workspace), or
 * to the new project page when there is none.
 */
export function AccountSidebarView({ projectId }: { projectId: string | null }) {
  const pathname = useRenderedPathname()
  const navigate = useNavigate()
  const { projects } = useProjectsSummary()
  const { current, workspaces } = useWorkspace()
  const projectName = projectId ? (projects.find((project) => project.id === projectId)?.name ?? null) : null
  const billingAccountId = current && canReadBillingOf(current) ? (current.billingAccount?.id ?? null) : null
  const billingLabel = current && workspaces.length > 1 ? `Billing · ${current.name}` : "Billing"

  const backText = projectId ? `Back to ${projectName ?? "project"}` : "Back to new project"
  function back(): void {
    if (projectId) void navigate({ to: "/dashboard/projects/$projectId/project", params: { projectId } })
    else void navigate({ to: "/dashboard/projects/new" })
  }

  return (
    <>
      <SidebarViewHeader label="Account" backLabel={backText} backText={backText} onBack={back} />
      <nav aria-label="Account" className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-3.5">
        <SidebarNavLink
          to="/dashboard/settings"
          icon={UserRound}
          label="Account settings"
          active={pathname === "/dashboard/settings"}
        />
        <SidebarNavLink
          to="/dashboard/teams"
          icon={Users}
          label="Teams"
          active={pathname === "/dashboard/teams" || pathname.startsWith("/dashboard/teams/")}
        />
        {billingAccountId ? (
          <>
            <SidebarSectionLabel>{billingLabel}</SidebarSectionLabel>
            <SidebarNavLink
              to="/dashboard/billing/$accountId"
              params={{ accountId: billingAccountId }}
              icon={CreditCard}
              label="Plan and invoices"
              active={PLAN_PAGE.test(pathname)}
            />
            <SidebarNavLink
              to="/dashboard/billing/$accountId/credits"
              params={{ accountId: billingAccountId }}
              icon={Coins}
              label="AI credits"
              active={CREDITS_PAGE.test(pathname)}
            />
          </>
        ) : null}
      </nav>
      <SidebarViewFooter>
        <UserRow />
      </SidebarViewFooter>
    </>
  )
}
