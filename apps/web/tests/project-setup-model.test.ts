import { describe, expect, test } from "vitest"

import {
  buildSetupSteps,
  countFinishedSteps,
  isSetupFinished,
  type SetupFacts,
  type SetupStepId,
} from "~/lib/dashboard/project-setup-model"

const NEW_PROJECT: SetupFacts = {
  repositoryFullName: null,
  hasInstructions: false,
  hasFinishedGeneration: false,
  hasAgentAccess: false,
  hasCustomDomain: false,
}

function statuses(facts: Partial<SetupFacts>, skipped: SetupStepId[] = []) {
  return Object.fromEntries(
    buildSetupSteps({ ...NEW_PROJECT, ...facts }, new Set(skipped)).map((step) => [step.id, step.status]),
  )
}

describe("the setup checklist", () => {
  test("a new project starts at the repository", () => {
    expect(statuses({})).toEqual({
      repository: "current",
      instructions: "upcoming",
      generation: "upcoming",
      agent: "upcoming",
      domain: "upcoming",
    })
  })

  test("the first open step is the current one, and a fact finishes a step in any order", () => {
    expect(statuses({ repositoryFullName: "acme/api", hasCustomDomain: true })).toMatchObject({
      repository: "done",
      instructions: "current",
      generation: "upcoming",
      domain: "done",
    })
  })

  test("instructions stop being a step once the first generation finished", () => {
    expect(statuses({ repositoryFullName: "acme/api", hasFinishedGeneration: true })).toMatchObject({
      instructions: "done",
      agent: "current",
    })
  })

  test("a skipped optional step passes the current step on", () => {
    expect(statuses({ repositoryFullName: "acme/api" }, ["instructions"])).toMatchObject({
      instructions: "skipped",
      generation: "current",
    })
  })

  test("a required step cannot be skipped", () => {
    expect(statuses({}, ["repository"]).repository).toBe("current")
  })

  test("a fact wins over a skip", () => {
    expect(statuses({ hasInstructions: true }, ["instructions"]).instructions).toBe("done")
  })

  test("the checklist finishes when each step is done or skipped", () => {
    const steps = buildSetupSteps(
      { ...NEW_PROJECT, repositoryFullName: "acme/api", hasFinishedGeneration: true },
      new Set<SetupStepId>(["instructions", "agent", "domain"]),
    )

    expect(countFinishedSteps(steps)).toBe(5)
    expect(isSetupFinished(steps)).toBe(true)
    expect(isSetupFinished(buildSetupSteps(NEW_PROJECT, new Set()))).toBe(false)
  })
})
