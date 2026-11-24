import { usePrefetchQuery, useQuery } from "@tanstack/react-query"
import { BetaTag } from "~/components/dashboard/beta-tag"

import { PageBody, PageHeading } from "~/components/dashboard/dashboard-header"
import { AllowedBotsCard } from "~/components/dashboard/doxabot/allowed-bots-card"
import { DoxabotAutomationWarningBanner } from "~/components/dashboard/doxabot/automation-warning-banner"
import { DoxabotPageActions } from "~/components/dashboard/doxabot/doxabot-page-actions"
import { DoxabotStatusRow } from "~/components/dashboard/doxabot/doxabot-status-row"
import { GenerationCacheCard } from "~/components/dashboard/doxabot/generation-cache-card"
import { InstructionsCard } from "~/components/dashboard/doxabot/instructions-card"
import { ProductionBranchCard } from "~/components/dashboard/doxabot/production-branch-card"
import { DoxabotMergeUpdatesCard } from "~/components/dashboard/doxabot-merge-trigger"
import { DoxabotSettingsCard } from "~/components/dashboard/project-doxabot-page"
import {
  DOXABOT_PAGE_DESCRIPTION,
  ProjectDoxabotSkeleton,
} from "~/components/dashboard/skeletons/doxabot-skeletons"
import { getDoxabotAutomationNotice } from "~/lib/dashboard/doxabot-model"
import { getDoxabotStatusFacts } from "~/lib/dashboard/doxabot-status-model"
import { useIsFirstLoad } from "~/lib/dashboard/use-first-load"
import { useProjectCapabilities } from "~/lib/dashboard/use-project-capabilities"
import {
  projectDetailQueryOptions,
  projectDoxabotQueryOptions,
  projectGenerationCacheQueryOptions,
  projectRepositoryBranchesQueryOptions,
} from "~/lib/queries/dashboard"
import { doxabotInstructionsQueryOptions } from "~/lib/queries/doxabot-instructions"

/** The project's Doxabot page: everything about how Doxabot runs and writes. */
export function ProjectDoxabotPage({ projectId }: { projectId: string }) {
  // The cards read these queries too. The page waits for all of them, so it
  // shows one skeleton and then every card at once.
  const detailQuery = useQuery(projectDetailQueryOptions(projectId))
  const doxabotQuery = useQuery(projectDoxabotQueryOptions(projectId))
  const cacheQuery = useQuery(projectGenerationCacheQueryOptions(projectId))
  const instructionsQuery = useQuery(doxabotInstructionsQueryOptions(projectId))
  // GitHub answers the branch list slowly, so it starts with the page. The
  // page does not wait for it: only the branch picker uses it.
  usePrefetchQuery(projectRepositoryBranchesQueryOptions(projectId))
  const { can } = useProjectCapabilities(projectId)

  const isFirstLoad = useIsFirstLoad([detailQuery, doxabotQuery, cacheQuery, instructionsQuery])
  if (isFirstLoad) return <ProjectDoxabotSkeleton />

  const project = detailQuery.data?.project ?? null
  const instructions = instructionsQuery.data?.current ?? null
  const facts = getDoxabotStatusFacts({
    project,
    latestJob: detailQuery.data?.latestJob ?? null,
    instructions,
    doxabot: doxabotQuery.data ?? null,
  })
  const automationNotice = getDoxabotAutomationNotice(doxabotQuery.data ?? null)

  return (
    <PageBody className="max-w-4xl">
      <PageHeading label="Project" title="Doxabot" titleTag={<BetaTag />} description={DOXABOT_PAGE_DESCRIPTION} />
      <DoxabotPageActions projectId={projectId} canRun={can("generation.run") && Boolean(project?.repositoryFullName)} />

      <section className="flex flex-col gap-4">
        {automationNotice ? <DoxabotAutomationWarningBanner notice={automationNotice} /> : null}
        <DoxabotStatusRow facts={facts} />
        <InstructionsCard projectId={projectId} current={instructions} />
        <ProductionBranchCard projectId={projectId} />
        <DoxabotSettingsCard projectId={projectId} />
        <AllowedBotsCard projectId={projectId} />
        <DoxabotMergeUpdatesCard projectId={projectId} />
        <GenerationCacheCard projectId={projectId} />
      </section>
    </PageBody>
  )
}
