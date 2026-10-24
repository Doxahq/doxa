import { describe, expect, test } from "vitest";
import {
  resolveCompatiblePreviewBaseline,
  type PreviewBaselineCandidate,
} from "../../src/repositories/preview-baselines";

const projectId = "11111111-1111-4111-8111-111111111111";
const siteId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";
const sourceRevision = "a".repeat(40);
const sourceTreeHash = "b".repeat(40);
const generatorFingerprint = "doxabot-v1:model:full-prod:100";
const versionCreatedAt = new Date("2026-01-01T00:00:00.000Z");

function candidate(
  overrides: Partial<PreviewBaselineCandidate> = {},
): PreviewBaselineCandidate {
  return {
    projectId,
    provider: "github",
    changeExternalId: "pr-node-42",
    currentVersionId: versionId,
    versionId,
    siteId,
    versionChannel: "preview",
    sourceRevision,
    sourceTreeHash,
    versionGeneratorFingerprint: generatorFingerprint,
    generationStatePrefix:
      `sites/${siteId}/generation-state/${versionId}`,
    jobStatus: "succeeded",
    jobTrigger: "doxabot",
    jobPublicationMode: "preview",
    jobProvider: "github",
    jobChangeExternalId: "pr-node-42",
    jobTargetRevision: sourceRevision,
    jobGeneratorFingerprint: generatorFingerprint,
    versionCreatedAt,
    generationBaselineResetAt: null,
    ...overrides,
  };
}

const input = {
  projectId,
  provider: "github" as const,
  changeExternalId: "pr-node-42",
};

describe("preview baseline compatibility", () => {
  test("selects a successful preview from the exact same pull request", () => {
    expect(
      resolveCompatiblePreviewBaseline(candidate(), input),
    ).toEqual({
      versionId,
      sourceRevision,
    });
  });

  test.each([
    ["missing candidate", undefined],
    ["failed preview", candidate({ jobStatus: "failed" })],
    [
      "different pull request",
      candidate({
        changeExternalId: "pr-node-43",
        jobChangeExternalId: "pr-node-43",
      }),
    ],
    [
      "non-current version",
      candidate({ currentVersionId: "44444444-4444-4444-8444-444444444444" }),
    ],
    [
      "missing source identity",
      candidate({ sourceTreeHash: null }),
    ],
    [
      "mismatched source revision",
      candidate({ jobTargetRevision: "c".repeat(40) }),
    ],
    [
      "non-canonical generation state",
      candidate({
        generationStatePrefix:
          `sites/${siteId}/versions/${versionId}/generation-state`,
      }),
    ],
  ])("rejects %s", (_label, value) => {
    expect(
      resolveCompatiblePreviewBaseline(value, input),
    ).toBeNull();
  });

  test("accepts schema-compatible state produced with another model configuration", () => {
    expect(
      resolveCompatiblePreviewBaseline(
        candidate({
          versionGeneratorFingerprint: "old-generator",
          jobGeneratorFingerprint: "old-generator",
        }),
        input,
      ),
    ).toEqual({ versionId, sourceRevision });
  });

  test("rejects a preview produced at or before a generation cache clear", () => {
    for (const resetAt of [
      versionCreatedAt,
      new Date(versionCreatedAt.getTime() + 1_000),
    ]) {
      expect(
        resolveCompatiblePreviewBaseline(
          candidate({ generationBaselineResetAt: resetAt }),
          input,
        ),
      ).toBeNull();
    }
  });

  test("accepts a preview produced after a generation cache clear", () => {
    expect(
      resolveCompatiblePreviewBaseline(
        candidate({
          generationBaselineResetAt: new Date(
            versionCreatedAt.getTime() - 1_000,
          ),
        }),
        input,
      ),
    ).toEqual({ versionId, sourceRevision });
  });
});
