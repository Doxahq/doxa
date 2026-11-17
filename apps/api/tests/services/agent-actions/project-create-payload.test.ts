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
