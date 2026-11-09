export const SETUP_STEP_IDS = ["repository", "instructions", "generation", "agent", "domain"] as const

export type SetupStepId = (typeof SETUP_STEP_IDS)[number]

/** What the project already has. Each step is done because of a fact, not a click. */
export interface SetupFacts {
  repositoryFullName: string | null
  hasInstructions: boolean
  hasFinishedGeneration: boolean
  hasAgentAccess: boolean
  hasCustomDomain: boolean
}

export type SetupStepStatus = "done" | "skipped" | "current" | "upcoming"

export interface SetupStep {
  id: SetupStepId
  title: string
  text: string
  optional: boolean
  status: SetupStepStatus
}

function isFinished(step: Pick<SetupStep, "status">): boolean {
  return step.status === "done" || step.status === "skipped"
}

/** The steps in order. The first step that is neither done nor skipped is the current one. */
export function buildSetupSteps(facts: SetupFacts, skipped: ReadonlySet<SetupStepId>): SetupStep[] {
  const definitions: (Omit<SetupStep, "status"> & { done: boolean })[] = [
    {
      id: "repository",
      title: "Connect a repository",
      text: facts.repositoryFullName
        ? `Doxabot reads ${facts.repositoryFullName}.`
        : "Doxabot reads your repository to write your docs.",
      optional: false,
      done: facts.repositoryFullName !== null,
    },
    {
      id: "instructions",
      title: "Give Doxabot instructions",
      text: "Tell Doxabot who reads your docs and how they should sound.",
      optional: true,
      // Instructions shape the first generation. After it, this is not a setup step.
      done: facts.hasInstructions || facts.hasFinishedGeneration,
    },
    {
      id: "generation",
      title: "Run the first generation",
      text: "Doxabot reads your repository, writes your docs and publishes them to your site.",
      optional: false,
      done: facts.hasFinishedGeneration,
    },
    {
      id: "agent",
      title: "Connect an agent with MCP",
      text: "Let Claude Code or another agent read and edit these docs.",
      optional: true,
      done: facts.hasAgentAccess,
    },
    {
      id: "domain",
      title: "Add a custom domain",
      text: "Serve your docs from your own domain.",
      optional: true,
      done: facts.hasCustomDomain,
    },
  ]

  let hasCurrent = false
  return definitions.map(({ done, ...step }) => {
    if (done) return { ...step, status: "done" }
    if (step.optional && skipped.has(step.id)) return { ...step, status: "skipped" }
    if (hasCurrent) return { ...step, status: "upcoming" }
    hasCurrent = true
    return { ...step, status: "current" }
  })
}

export function countFinishedSteps(steps: readonly SetupStep[]): number {
  return steps.filter(isFinished).length
}

export function isSetupFinished(steps: readonly SetupStep[]): boolean {
  return steps.every(isFinished)
}
