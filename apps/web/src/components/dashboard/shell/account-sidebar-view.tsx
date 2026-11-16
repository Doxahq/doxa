import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Coins, CreditCard, UserRound, Users } from "lucide-react"

import { UserRow } from "~/components/dashboard/shell/sidebar-footer"
import { SidebarNavLink, SidebarSectionLabel } from "~/components/dashboard/shell/sidebar-nav"
import { SidebarViewFooter, SidebarViewHeader } from "~/components/dashboard/shell/sidebar-view-stack"
import { defaultBillingAccountId } from "~/lib/dashboard/billing-model"
import { useShell } from "~/lib/dashboard/shell-context"
import { usePageSettled } from "~/lib/dashboard/use-page-settled"
import { useProjectsSummary } from "~/lib/dashboard/use-projects-summary"
import { useRenderedPathname } from "~/lib/dashboard/use-rendered-pathname"
import { billingAccountsQueryOptions } from "~/lib/queries/billing"

const PLAN_PAGE = /^\/dashboard\/billing(?:\/[^/]+)?\/?$/
const CREDITS_PAGE = /^\/dashboard\/billing\/[^/]+\/credits\/?$/

/**
 * The Account sidebar view: Account settings, Teams, and the billing pages of
 * the default billing account: the first one on a paid plan, else the
 * personal one. It slides in like Site settings, and its back button returns
 * to the shell's project (the last opened one), or to the new project page
 * when there is none.
 */
export function AccountSidebarView({ projectId }: { projectId: string | null }) {
  const pathname = useRenderedPathname()
  const navigate = useNavigate()
  const { view } = useShell()
  const { projects } = useProjectsSummary()
  const projectName = projectId ? (projects.find((project) => project.id === projectId)?.name ?? null) : null
  // Hidden until an account page opens, so the read waits until the page settles.
  const isSettled = usePageSettled()
  const accounts = useQuery({ ...billingAccountsQueryOptions(), enabled: isSettled || view === "account" })
  const billingAccountId = accounts.data ? defaultBillingAccountId(accounts.data.accounts) : null

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
            <SidebarSectionLabel>Billing</SidebarSectionLabel>
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
        <UserRow projectId={projectId} />
      </SidebarViewFooter>
    </>
  )
}
