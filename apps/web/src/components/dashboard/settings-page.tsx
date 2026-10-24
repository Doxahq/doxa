import { Link } from "@tanstack/react-router"
import { ChevronRight, Github, Link2, Users } from "lucide-react"

import {
  DashboardHeader,
  FieldList,
  FieldRow,
  PageBody,
  SectionLabel,
} from "~/components/dashboard/dashboard-header"
import { ConnectedAgentsSection } from "~/components/dashboard/settings/connected-agents-section"
import { EmailNotificationsSection } from "~/components/dashboard/settings/email-notifications-section"
import { UserApprovalSettingsSection } from "~/components/dashboard/settings/user-approval-settings-section"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { useDashboardAuth } from "~/lib/auth/dashboard-auth-context"
import { useQuery } from "@tanstack/react-query"
import { AccountSettingsSkeleton } from "~/components/dashboard/skeletons/account-skeletons"
import { agentGrantsQueryOptions } from "~/lib/queries/agent-access"
import { userApprovalSettingsQueryOptions } from "~/lib/queries/approval-settings"
import { emailPreferencesQueryOptions } from "~/lib/queries/email-preferences"
import { useIsFirstLoad } from "~/lib/dashboard/use-first-load"
import { useGitHub } from "~/lib/dashboard/use-github"

export function SettingsPage() {
  const auth = useDashboardAuth()
  const { user } = auth
  const github = useGitHub()
  // The sections read these too. The page waits for all of them, so it shows
  // one skeleton and then every section at once.
  const isFirstLoad = useIsFirstLoad([
    { isPending: auth.isPending },
    { isPending: github.isLoading },
    useQuery(emailPreferencesQueryOptions()),
    useQuery(agentGrantsQueryOptions()),
    useQuery(userApprovalSettingsQueryOptions()),
  ])

  if (isFirstLoad) return <AccountSettingsSkeleton />

  return (
    <>
      <DashboardHeader title="Settings" />

      <PageBody>
        <AccountSection name={user?.name ?? null} email={user?.email ?? null} />
        <GitHubConnectionSection
          isConnected={github.isConnected}
          repositoryCount={github.repositories.length}
          githubInstallUrl={github.githubInstallUrl}
        />
        <TeamsLinkSection />
        <EmailNotificationsSection />
        <ConnectedAgentsSection />
        <UserApprovalSettingsSection />
      </PageBody>
    </>
  )
}

/** Teams live on their own page; settings links to it. */
function TeamsLinkSection() {
  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>Teams</SectionLabel>
      <div className="surface-card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <Users className="size-4 text-muted-foreground" />
          <span className="text-sm text-foreground">Share projects with your team, by role.</span>
        </div>
        <Button variant="outline" size="sm" className="w-fit" asChild>
          <Link to="/dashboard/teams">
            Manage teams
            <ChevronRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </section>
  )
}

function AccountSection({
  name,
  email,
}: {
  name: string | null
  email: string | null
}) {
  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>Account</SectionLabel>
      <FieldList>
        <FieldRow label="Name">{name || "—"}</FieldRow>
        <FieldRow label="Email">{email || "—"}</FieldRow>
      </FieldList>
    </section>
  )
}

function GitHubConnectionSection({
  isConnected,
  repositoryCount,
  githubInstallUrl,
}: {
  isConnected: boolean
  repositoryCount: number
  githubInstallUrl: string
}) {
  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>GitHub connection</SectionLabel>
      <div className="surface-card flex flex-col gap-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Github className="size-4 text-muted-foreground" />
            <span className="text-sm text-foreground">
              {isConnected
                ? `${repositoryCount} repositories connected`
                : "Not connected"}
            </span>
          </div>
          {isConnected ? (
            <Badge variant="success">connected</Badge>
          ) : (
            <Badge variant="muted">disconnected</Badge>
          )}
        </div>
        <div>
          <Button variant={isConnected ? "outline" : "default"} size="sm" asChild>
            <a href={githubInstallUrl}>
              {isConnected ? <Link2 /> : <Github />}
              {isConnected ? "Manage access" : "Connect GitHub App"}
            </a>
          </Button>
        </div>
      </div>
    </section>
  )
}
