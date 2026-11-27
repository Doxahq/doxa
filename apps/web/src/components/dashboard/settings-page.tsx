import { useQuery } from "@tanstack/react-query"
import { Github, Link2 } from "lucide-react"

import { FieldList, FieldRow, SectionLabel } from "~/components/dashboard/dashboard-header"
import { AccountPageFrame } from "~/components/dashboard/settings/account-page-frame"
import { PrivacySettingsSection } from "~/components/dashboard/settings/privacy-settings-section"
import { GitHubInstallationsSection } from "~/components/dashboard/settings/github-installations-section"
import { AccountSettingsSkeleton } from "~/components/dashboard/skeletons/account-skeletons"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { useDashboardAuth } from "~/lib/auth/dashboard-auth-context"
import { ACCOUNT_PAGES } from "~/lib/dashboard/account-pages"
import { useIsFirstLoad } from "~/lib/dashboard/use-first-load"
import { useGitHub } from "~/lib/dashboard/use-github"
import { billingAccountsQueryOptions } from "~/lib/queries/billing"
import { REPLAY_MASK_PROPS } from "~/lib/analytics/replay-privacy"
import { githubInstallationsQueryOptions } from "~/lib/queries/dashboard"
import { privacySettingsQueryOptions } from "~/lib/queries/privacy-settings"

/**
 * `/dashboard/settings`: Account settings, the profile, the GitHub connection and the product analytics switch.
 * Notifications, agents, teams and billing have their own pages in the Account sidebar.
 */
export function SettingsPage() {
  const auth = useDashboardAuth()
  const { user } = auth
  const github = useGitHub()
  // The page waits for all of these, so it shows one skeleton and then every section at once.
  // The billing accounts fill the Account sidebar's BILLING group, so it shows with the page.
  const isFirstLoad = useIsFirstLoad([
    { isPending: auth.isPending },
    { isPending: github.isLoading },
    useQuery(billingAccountsQueryOptions()),
    useQuery(githubInstallationsQueryOptions()),
    useQuery(privacySettingsQueryOptions()),
  ])

  if (isFirstLoad) return <AccountSettingsSkeleton />

  return (
    <AccountPageFrame page={ACCOUNT_PAGES.account}>
      <AccountSection name={user?.name ?? null} email={user?.email ?? null} />
      <GitHubConnectionSection
        isConnected={github.isConnected}
        repositoryCount={github.repositories.length}
        githubInstallUrl={github.githubInstallUrl}
      />
      <GitHubInstallationsSection />
      <PrivacySettingsSection />
    </AccountPageFrame>
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
      <SectionLabel>Profile</SectionLabel>
      <FieldList>
        <FieldRow label="Name">{name || "—"}</FieldRow>
        <FieldRow label="Email">{email ? <span {...REPLAY_MASK_PROPS}>{email}</span> : "—"}</FieldRow>
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
