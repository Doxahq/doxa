import { describe, expect, test } from "vitest";
import {
  resolveCompatibleProductionBaseline,
  type ProductionBaselineCandidate,
} from "../../src/repositories/production-baselines";

const versionId = "11111111-1111-4111-8111-111111111111";
const siteId = "22222222-2222-4222-8222-222222222222";
const sourceRevision = "a".repeat(40);
const sourceTreeHash = "b".repeat(40);
const generatorFingerprint = "historical-generator";
const versionCreatedAt = new Date("2026-01-01T00:00:00.000Z");
describe("production baseline compatibility", () => {
  test("accepts the current published production version with canonical state", () => {
    expect(
      resolveCompatibleProductionBaseline(candidate(), {
        projectId: "project-1",
      }),
    ).toEqual({
      versionId,
      sourceRevision,
      sourceTreeHash,
      generatorFingerprint,
      siteId,
      generationStatePrefix: `sites/${siteId}/generation-state/${versionId}`,
    });
  });

  test("accepts a version published after the generation cache was cleared", () => {
    expect(
      resolveCompatibleProductionBaseline(
        candidate({
          generationBaselineResetAt: new Date(
            versionCreatedAt.getTime() - 1_000,
          ),
        }),
        { projectId: "project-1" },
      ),
    ).toEqual({
      versionId,
      sourceRevision,
      sourceTreeHash,
      generatorFingerprint,
      siteId,
      generationStatePrefix: `sites/${siteId}/generation-state/${versionId}`,
    });
  });

  test("accepts schema-compatible state produced with another model configuration", () => {
    expect(
      resolveCompatibleProductionBaseline(
        candidate({ generatorFingerprint: "another-generator" }),
        { projectId: "project-1" },
      ),
    ).toEqual({
      versionId,
      sourceRevision,
      sourceTreeHash,
      generatorFingerprint: "another-generator",
      siteId,
      generationStatePrefix: `sites/${siteId}/generation-state/${versionId}`,
    });
  });

  test("accepts a reviewed publication that names the state of its staged run", () => {
    const stagedVersionId = "33333333-3333-4333-8333-333333333333";

    expect(
      resolveCompatibleProductionBaseline(
        candidate({
          generationStatePrefix: `sites/${siteId}/generation-state/${stagedVersionId}`,
        }),
        { projectId: "project-1" },
      ),
    ).toEqual({
      versionId,
      sourceRevision,
      sourceTreeHash,
      generatorFingerprint,
      siteId,
      generationStatePrefix: `sites/${siteId}/generation-state/${stagedVersionId}`,
    });
  });

  test.each([
    candidate({ publishedVersionId: null }),
    candidate({
      generationStatePrefix: `sites/${siteId}/content-versions/${versionId}`,
    }),
    candidate({
      generationStatePrefix: `sites/another-site/generation-state/${versionId}`,
    }),
    candidate({ versionChannel: "preview" }),
    candidate({ sourceRevision: null }),
    candidate({ sourceTreeHash: null }),
    candidate({
      generationStatePrefix:
        `sites/${siteId}/versions/${versionId}/generation-state`,
    }),
    candidate({
      generationBaselineResetAt: new Date(
        versionCreatedAt.getTime() + 1_000,
      ),
    }),
    candidate({ generationBaselineResetAt: versionCreatedAt }),
  ])("rejects an incompatible published version", (incompatible) => {
    expect(
      resolveCompatibleProductionBaseline(incompatible, {
        projectId: "project-1",
      }),
    ).toBeNull();
  });
});

function candidate(
  overrides: Partial<ProductionBaselineCandidate> = {},
): ProductionBaselineCandidate {
  return {
    projectId: "project-1",
    publishedVersionId: versionId,
    versionId,
    siteId,
    versionChannel: "production",
    sourceRevision,
    sourceTreeHash,
    generatorFingerprint,
    generationStatePrefix:
      `sites/${siteId}/generation-state/${versionId}`,
    versionCreatedAt,
    generationBaselineResetAt: null,
    ...overrides,
  };
}
