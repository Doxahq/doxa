import { ContentPagePending } from "~/components/dashboard/content/editor-skeleton"
import { GenerationChangesPending } from "~/components/dashboard/generation-changes/generation-changes-pending"
import { AccountSettingsSkeleton, TeamSkeleton, TeamsSkeleton } from "~/components/dashboard/skeletons/account-skeletons"
import {
  ProjectGenerationSkeleton,
  ProjectGenerationsSkeleton,
  ProjectOverviewSkeleton,
} from "~/components/dashboard/skeletons/project-skeletons"
import { ApprovalRequestSkeleton, ProjectRequestsSkeleton } from "~/components/dashboard/skeletons/request-skeletons"
import { DoxabotInstructionsSkeleton, ProjectDoxabotSkeleton } from "~/components/dashboard/skeletons/doxabot-skeletons"
import { ProjectApprovalsSkeleton, ProjectSettingsSkeleton } from "~/components/dashboard/skeletons/settings-skeletons"
import { SiteSettingsPending, SiteSettingsSectionPending } from "~/components/dashboard/skeletons/site-settings-skeletons"

/**
 * The view each dashboard route shows while its page loads, by name. Route
 * files name a view with `dashboardPendingView`; the dashboard layout
 * registers this map. So these skeletons, and the shell parts they draw (top
 * bar, sidebar state, review panels), load with the dashboard, not with the
 * main bundle that the marketing pages share.
 */
export const DASHBOARD_PENDING_VIEWS = {
  accountSettings: AccountSettingsSkeleton,
  approvalRequest: ApprovalRequestSkeleton,
  content: ContentPagePending,
  doxabotInstructions: DoxabotInstructionsSkeleton,
  generation: ProjectGenerationSkeleton,
  generationChanges: GenerationChangesPending,
  generations: ProjectGenerationsSkeleton,
  projectApprovals: ProjectApprovalsSkeleton,
  projectDoxabot: ProjectDoxabotSkeleton,
  projectOverview: ProjectOverviewSkeleton,
  projectRequests: ProjectRequestsSkeleton,
  projectSettings: ProjectSettingsSkeleton,
  siteSettings: SiteSettingsPending,
  siteSettingsSection: SiteSettingsSectionPending,
  team: TeamSkeleton,
  teams: TeamsSkeleton,
}

export type DashboardPendingViews = typeof DASHBOARD_PENDING_VIEWS
