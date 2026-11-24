import { describe, expect, it } from "vitest";
import { projectCreateAction } from "../../../src/services/agent-actions/actions/project-create";

const TEAM_ID = "22222222-2222-4222-8222-222222222222";

describe("project.create payload", () => {
  it("accepts a personal project from either source", () => {
    expect(projectCreateAction.payloadSchema.safeParse({ source: "example", name: "Acme" }).success).toBe(true);
    expect(
      projectCreateAction.payloadSchema.safeParse({
        source: "repository",
        githubRepositoryId: "33333333-3333-4333-8333-333333333333",
      }).success,
    ).toBe(true);
  });

  it("refuses a team, so an agent never creates a personal project by mistake", () => {
    expect(projectCreateAction.payloadSchema.safeParse({ source: "example", name: "Acme", teamId: TEAM_ID }).success).toBe(false);
  });
});

describe("project.create at the plan's project limit", () => {
  it("gives the agent a plan_limit error with the limit and the use", async () => {
    const { PlanLimitError } = await import("@doxahq/billing");
    const { ActionExecutionError } = await import("../../../src/services/agent-actions/errors");
    const refusal = new PlanLimitError({ key: "account.projects", limit: 1, used: 1, accountId: "acct_1", plan: "free" });
    const prepared = projectCreateAction.restore({ payload: { source: "example", name: "Acme" }, snapshot: {} });
    const projects = {
      createExample: async () => {
        throw refusal;
      },
      createForRepository: async () => {
        throw refusal;
      },
    };

    const run = prepared!.execute({
      target: { kind: "principal", userId: "user-1" as never },
      services: { projects } as never,
      requester: {} as never,
      decision: {} as never,
    });
    await expect(run).rejects.toBeInstanceOf(ActionExecutionError);
    await expect(run).rejects.toMatchObject({
      code: "plan_limit",
      message: "The account's plan allows 1 for account.projects and uses 1. Upgrade the plan in the Doxa dashboard.",
    });
  });
});
