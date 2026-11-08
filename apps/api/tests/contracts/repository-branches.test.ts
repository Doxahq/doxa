import { describe, expect, test } from "vitest";
import {
  createProjectInputSchema,
  gitBranchNameSchema,
  updateDoxabotSettingsInputSchema,
} from "@doxahq/contracts";

describe("production branch names", () => {
  test.each(["main", "release/2.x", "feature/docs-v2", "v1.0", "user@host"])("accepts %s", (name) => {
    expect(gitBranchNameSchema.parse(name)).toBe(name);
  });

  test("trims the name", () => {
    expect(gitBranchNameSchema.parse("  main  ")).toBe("main");
  });

  test.each([
    "",
    "-main",
    "/main",
    "main/",
    "main.",
    "main.lock",
    "a..b",
    "a//b",
    "a@{1}",
    "@",
    "two words",
    "tab\tname",
    "a~1",
    "a^",
    "a:b",
    "a?",
    "a*",
    "a[b",
    "a\\b",
    "feature/.hidden",
    "x".repeat(256),
  ])("refuses %j", (name) => {
    expect(gitBranchNameSchema.safeParse(name).success).toBe(false);
  });

  test("a new project and a settings update take an optional production branch", () => {
    const githubRepositoryId = "11111111-1111-4111-8111-111111111111";
    expect(createProjectInputSchema.parse({ githubRepositoryId })).toEqual({ githubRepositoryId });
    expect(createProjectInputSchema.parse({ githubRepositoryId, productionBranch: "release" }).productionBranch).toBe(
      "release",
    );
    expect(updateDoxabotSettingsInputSchema.parse({ productionBranch: "release" })).toEqual({
      productionBranch: "release",
    });
    expect(updateDoxabotSettingsInputSchema.safeParse({ productionBranch: "bad name" }).success).toBe(false);
  });
});
