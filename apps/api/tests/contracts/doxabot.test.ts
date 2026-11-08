import { describe, expect, test } from "vitest";
import {
  doxabotEligibilitySchema,
  doxabotSettingsSchema,
  normalizedSourceControlEventSchema,
  sourceRevisionSchema,
  updateDoxabotSettingsInputSchema,
} from "@doxahq/contracts";

const repository = {
  provider: "github",
  externalId: "123456",
  installationExternalId: "789",
  visibility: "private",
  defaultBranch: "main",
} as const;

const revision = {
  commitSha: "a".repeat(40),
};

describe("Doxabot contracts", () => {
  test("parses a provider-neutral change proposal event", () => {
    const parsed = normalizedSourceControlEventSchema.parse({
      kind: "change_proposal",
      deliveryId: "delivery-1",
      action: "synchronize",
      repository,
      change: {
        externalId: "987654",
        number: 42,
        author: {
          externalId: "1",
          handle: "octocat",
          avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
        },
        draft: false,
        merged: false,
        baseRef: "main",
        baseRevision: revision,
        headRevision: { commitSha: "b".repeat(40) },
        sourceUpdatedAt: "2026-07-23T10:00:00.000Z",
      },
    });

    expect(parsed).toMatchObject({
      kind: "change_proposal",
      change: {
        author: {
          externalId: "1",
          handle: "octocat",
          avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
        },
      },
    });
  });

  test("keeps normalized deliveries from before author tracking readable", () => {
    expect(normalizedSourceControlEventSchema.parse({
      kind: "change_proposal",
      deliveryId: "legacy-delivery",
      action: "opened",
      repository,
      change: {
        externalId: "987654",
        number: 42,
        draft: false,
        merged: false,
        baseRef: "main",
        baseRevision: revision,
        headRevision: { commitSha: "b".repeat(40) },
        sourceUpdatedAt: "2026-07-23T10:00:00.000Z",
      },
    })).toMatchObject({
      kind: "change_proposal",
      change: { externalId: "987654" },
    });
  });

  test("parses default-branch pushes and repository lifecycle events", () => {
    expect(normalizedSourceControlEventSchema.parse({
      kind: "default_branch_push",
      deliveryId: "delivery-2",
      repository,
      ref: "refs/heads/main",
      beforeRevision: revision,
      afterRevision: { commitSha: "c".repeat(40) },
    }).kind).toBe("default_branch_push");

    expect(normalizedSourceControlEventSchema.parse({
      kind: "repository_lifecycle",
      deliveryId: "delivery-3",
      action: "disconnected",
      repository,
    }).kind).toBe("repository_lifecycle");
  });

  test("rejects malformed revisions and provider-specific payload fields", () => {
    expect(sourceRevisionSchema.safeParse({ commitSha: "not-a-git-object" }).success)
      .toBe(false);
    expect(normalizedSourceControlEventSchema.safeParse({
      kind: "change_proposal",
      deliveryId: "delivery-4",
      action: "opened",
      repository,
      pull_request: {},
      change: {
        externalId: "987654",
        number: 42,
        draft: false,
        merged: false,
        baseRef: "main",
        baseRevision: revision,
        headRevision: { commitSha: "b".repeat(40) },
        sourceUpdatedAt: "2026-07-23T10:00:00.000Z",
      },
    }).success).toBe(false);
  });

  test("keeps available and unavailable eligibility states disjoint", () => {
    expect(doxabotEligibilitySchema.parse({
      available: true,
      enabled: true,
      reason: null,
    })).toEqual({
      available: true,
      enabled: true,
      reason: null,
    });
    expect(doxabotEligibilitySchema.parse({
      available: false,
      enabled: false,
      reason: "public_repository_disabled",
    })).toEqual({
      available: false,
      enabled: false,
      reason: "public_repository_disabled",
    });
    expect(doxabotEligibilitySchema.safeParse({
      available: true,
      enabled: true,
      reason: "global_disabled",
    }).success).toBe(false);
  });

  test("parses Doxabot settings without conflating stored and available state", () => {
    expect(doxabotSettingsSchema.parse({
      enabled: true,
      mergeTrigger: "batched",
      batchQuietMinutes: 30,
      repositoryVisibility: "private",
      productionBranch: "release",
      repositoryDefaultBranch: "main",
      available: false,
      unavailableReason: "global_disabled",
      updatedAt: "2026-07-23T09:00:00.000Z",
    })).toEqual({
      enabled: true,
      mergeTrigger: "batched",
      batchQuietMinutes: 30,
      repositoryVisibility: "private",
      productionBranch: "release",
      repositoryDefaultBranch: "main",
      available: false,
      unavailableReason: "global_disabled",
      updatedAt: "2026-07-23T09:00:00.000Z",
    });
    expect(doxabotSettingsSchema.safeParse({
      enabled: false,
      mergeTrigger: "batched",
      batchQuietMinutes: 30,
      repositoryVisibility: "private",
      available: true,
      unavailableReason: "global_disabled",
      updatedAt: null,
    }).success).toBe(false);
  });

  test("accepts a partial update and rejects an empty or unknown one", () => {
    expect(updateDoxabotSettingsInputSchema.parse({ mergeTrigger: "every_merge" })).toEqual({
      mergeTrigger: "every_merge",
    });
    expect(updateDoxabotSettingsInputSchema.safeParse({}).success).toBe(false);
    expect(
      updateDoxabotSettingsInputSchema.safeParse({ batchQuietMinutes: 45 }).success,
    ).toBe(false);
  });

  test("accepts only the Doxabot enablement toggle as update input", () => {
    expect(updateDoxabotSettingsInputSchema.parse({ enabled: true })).toEqual({
      enabled: true,
    });
    expect(updateDoxabotSettingsInputSchema.safeParse({
      enabled: true,
      publicRepositoriesEnabled: true,
    }).success).toBe(false);
  });
});
