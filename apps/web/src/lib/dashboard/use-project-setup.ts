import { useQuery } from "@tanstack/react-query"
import type { DocsDomainDto, GenerationJobDto, ProjectDto } from "@doxahq/contracts"
import type { AgentGrantSummary } from "@doxahq/contracts/agent-access"

import { buildSetupSteps, isSetupFinished, type SetupStep } from "~/lib/dashboard/project-setup-model"
import { useProjectSetupPreferences, type ProjectSetupPreferences } from "~/lib/dashboard/project-setup-preferences"
import { agentGrantsQueryOptions } from "~/lib/queries/agent-access"
import { doxabotInstructionsQueryOptions } from "~/lib/queries/doxabot-instructions"

function grantCoversProject(grant: AgentGrantSummary, projectId: string): boolean {
  return grant.projectScope.kind === "all" || grant.projectScope.projectIds.includes(projectId)
}

export interface ProjectSetup extends Pick<ProjectSetupPreferences, "skip" | "hide"> {
  steps: SetupStep[]
  /** True when the checklist shows: this person can act and has steps left. */
  isVisible: boolean
  /** True when the person skipped the offer of instructions in the checklist. */
  skippedInstructions: boolean
  isLoading: boolean
}

/** The setup checklist of a project, from what the project already has. */
export function useProjectSetup(input: {
  projectId: string
  project: ProjectDto | null
  generations: readonly GenerationJobDto[]
  domains: readonly DocsDomainDto[]
  canRun: boolean
}): ProjectSetup {
  const { projectId, canRun } = input
  const { skipped, hidden, skip, hide } = useProjectSetupPreferences(projectId)
  const enabled = canRun && !hidden
  const instructions = useQuery({ ...doxabotInstructionsQueryOptions(projectId), enabled })
  const grants = useQuery({ ...agentGrantsQueryOptions(), enabled })

  const steps = buildSetupSteps(
    {
      repositoryFullName: input.project?.repositoryFullName ?? null,
      hasInstructions: Boolean(instructions.data?.current),
      hasFinishedGeneration: input.generations.some((generation) => generation.status === "succeeded"),
      hasAgentAccess: (grants.data?.grants ?? []).some((grant) => grantCoversProject(grant, projectId)),
      hasCustomDomain: input.domains.some((domain) => domain.kind === "custom_domain"),
    },
    skipped,
  )

  return {
    steps,
    isVisible: enabled && !isSetupFinished(steps),
    skippedInstructions: skipped.has("instructions"),
    isLoading: instructions.isLoading || grants.isLoading,
    skip,
    hide,
  }
}
