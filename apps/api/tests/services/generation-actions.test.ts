import { describe, expect, test } from "vitest";
import {
  awaitsGenerationReview,
  getDeleteBlockedReason,
  getPromoteBlockedReason,
  getRerunBlockedReason,
  promoteRetentionFacts,
  resolveGenerationActions,
} from "../../src/services/generation-actions";
import { resolveRetentionPolicy } from "../../src/services/retention-policy";

const NOW = new Date("2026-10-16T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1_000);

describe("generation actions", () => {
  test.each([
    [{ status: "running", docsVersionId: null, publishedVersionId: null }, "not_succeeded"],
    [{ status: "succeeded", docsVersionId: null, publishedVersionId: null }, "no_docs_version"],
    [{ status: "succeeded", docsVersionId: "version-1", publishedVersionId: "version-1" }, "already_production"],
    [{ status: "succeeded", docsVersionId: "version-1", publishedVersionId: "version-2" }, null],
    [{ status: "succeeded", docsVersionId: "version-1", publishedVersionId: "version-2", isServingProduction: true }, "already_production"],
    [{ status: "succeeded", docsVersionId: "version-1", publishedVersionId: "version-2", awaitsReview: true }, "review_required"],
    [{ status: "succeeded", docsVersionId: "version-1", publishedVersionId: "version-2", versionCollected: true }, "version_collected"],
    [{ status: "succeeded", docsVersionId: "version-1", publishedVersionId: "version-2", promoteExpired: true }, "promote_expired"],
  ] as const)("resolves promotion eligibility", (input, expected) => {
    expect(getPromoteBlockedReason(input)).toBe(expected);
  });

  test.each([
    [{ status: "queued", docsVersionId: null, publishedVersionId: null, isServingPreview: false }, "in_progress"],
    [{ status: "succeeded", docsVersionId: "version-1", publishedVersionId: "version-1", isServingPreview: false }, "serving_production"],
    [{ status: "succeeded", docsVersionId: "version-1", publishedVersionId: null, isServingPreview: true }, "serving_preview"],
    [{ status: "failed", docsVersionId: null, publishedVersionId: null, isServingPreview: false }, null],
    [{ status: "succeeded", docsVersionId: "version-1", publishedVersionId: "version-2", isServingPreview: false, isServingProduction: true }, "serving_production"],
  ] as const)("resolves deletion eligibility", (input, expected) => {
    expect(getDeleteBlockedReason(input)).toBe(expected);
  });

  const openReview = { status: "open", publishedVersionId: null } as const;
  test.each([
    [{ publicationMode: "production", versionStatus: "staged", review: openReview }, true],
    [{ publicationMode: "production", versionStatus: "published", review: null }, false],
    [{ publicationMode: "preview", versionStatus: "staged", review: null }, false],
    [{ publicationMode: "production", versionStatus: null, review: null }, false],
    // The version stays staged after the review closes or moves to a newer run.
    [{ publicationMode: "production", versionStatus: "staged", review: { status: "published", publishedVersionId: "version-2" } }, false],
    [{ publicationMode: "production", versionStatus: "staged", review: { status: "discarded", publishedVersionId: null } }, false],
    [{ publicationMode: "production", versionStatus: "staged", review: null }, false],
  ] as const)("knows when a production run waits for its review", (input, expected) => {
    expect(awaitsGenerationReview(input)).toBe(expected);
  });

  test.each([
    [{ status: "queued" }, "not_finished"],
    [{ status: "running" }, "not_finished"],
    [{ status: "failed", publicationMode: "production" }, null],
    [{ status: "cancelled", publicationMode: "production" }, null],
    [{ status: "succeeded", publicationMode: "production" }, null],
    [{ status: "succeeded", publicationMode: "preview", changeState: "open", isSuperseded: true }, "superseded"],
    [{ status: "failed", publicationMode: "preview", changeState: "open" }, null],
    [{ status: "failed", publicationMode: "preview", changeState: "merged" }, "change_not_open"],
    [{ status: "failed", publicationMode: "preview", changeState: "open", isSuperseded: true }, "superseded"],
    [{ status: "failed", publicationMode: "preview", changeState: "open", changeOffProductionBranch: true }, "base_not_production"],
    // A closed pull request says so first: its base no longer matters.
    [{ status: "failed", publicationMode: "preview", changeState: "closed", changeOffProductionBranch: true }, "change_not_open"],
    [{ status: "failed", publicationMode: "production", changeOffProductionBranch: true }, null],
  ] as const)("knows when a run can run again", (input, expected) => {
    expect(getRerunBlockedReason(input)).toBe(expected);
  });

  test("returns flags and reasons from one shared rule set", () => {
    expect(
      resolveGenerationActions({
        status: "succeeded",
        docsVersionId: "version-1",
        publishedVersionId: "version-2",
        isServingPreview: false,
      }),
    ).toEqual({
      canPromote: true,
      canDelete: true,
      canRerun: true,
      canResume: false,
      promoteBlockedReason: null,
      deleteBlockedReason: null,
      rerunBlockedReason: null,
      resumeBlockedReason: "not_resumable",
    });
  });

  test("closes Promote for a preview replaced longer ago than the policy allows", () => {
    const policy = resolveRetentionPolicy({ id: "project-1" });
    const replaced = (days: number) => ({
      channel: "preview" as const,
      previewReplacedAt: daysAgo(days),
      artifactsCollectedAt: null,
    });

    expect(promoteRetentionFacts(replaced(6), policy, NOW)).toEqual({
      versionCollected: false,
      promoteExpired: false,
    });
    expect(promoteRetentionFacts(replaced(8), policy, NOW)).toEqual({
      versionCollected: false,
      promoteExpired: true,
    });
    expect(
      promoteRetentionFacts(
        replaced(8),
        resolveRetentionPolicy({ id: "project-1", retentionOverrides: { previewPromoteDays: 30 } }),
        NOW,
      ).promoteExpired,
    ).toBe(false);
  });

  test("closes Promote for a collected version on any channel", () => {
    const policy = resolveRetentionPolicy({ id: "project-1" });
    expect(
      promoteRetentionFacts(
        { channel: "production", previewReplacedAt: null, artifactsCollectedAt: daysAgo(1) },
        policy,
        NOW,
      ),
    ).toEqual({ versionCollected: true, promoteExpired: false });
    expect(promoteRetentionFacts(null, policy, NOW)).toEqual({
      versionCollected: false,
      promoteExpired: false,
    });
  });
});
