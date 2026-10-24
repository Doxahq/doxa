import {
  DEFAULT_RETENTION_POLICY,
  isPreviewPromotable,
  keepsProductionVersion,
  retentionPolicyOverridesSchema,
} from "@doxahq/contracts/retention-policy";
import { describe, expect, test } from "vitest";

import { resolveRetentionPolicy } from "../../src/services/retention-policy";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = new Date("2026-10-16T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

describe("retention policy resolver", () => {
  test("returns the default policy for a project without a plan", () => {
    expect(resolveRetentionPolicy({ id: "project-1" })).toEqual({
      productionHistory: { keepLatest: 20, keepDays: 90 },
      previewPromoteDays: 7,
    });
    expect(resolveRetentionPolicy({ id: "project-1" })).toEqual(
      DEFAULT_RETENTION_POLICY,
    );
  });

  test("merges a partial plan override over the default", () => {
    const policy = resolveRetentionPolicy({
      id: "project-1",
      retentionOverrides: {
        productionHistory: { keepDays: 365 },
        previewPromoteDays: 30,
      },
    });

    expect(policy).toEqual({
      productionHistory: { keepLatest: 20, keepDays: 365 },
      previewPromoteDays: 30,
    });
  });

  test("rejects an override that is not a positive count or an unknown field", () => {
    expect(
      retentionPolicyOverridesSchema.safeParse({ previewPromoteDays: 0 }).success,
    ).toBe(false);
    expect(
      retentionPolicyOverridesSchema.safeParse({ storageDays: 3 }).success,
    ).toBe(false);
  });
});

describe("production history rule", () => {
  const policy = DEFAULT_RETENTION_POLICY;

  test("keeps a version that only the count rule keeps", () => {
    expect(
      keepsProductionVersion({ rank: 20, lastPublishedAt: daysAgo(400) }, policy, NOW),
    ).toBe(true);
  });

  test("keeps a version that only the age rule keeps", () => {
    expect(
      keepsProductionVersion({ rank: 50, lastPublishedAt: daysAgo(89) }, policy, NOW),
    ).toBe(true);
  });

  test("lets a version go only when neither rule keeps it", () => {
    expect(
      keepsProductionVersion({ rank: 21, lastPublishedAt: daysAgo(90) }, policy, NOW),
    ).toBe(false);
  });

  test("applies an override at decision time", () => {
    const longer = resolveRetentionPolicy({
      id: "project-1",
      retentionOverrides: { productionHistory: { keepLatest: 100 } },
    });

    expect(
      keepsProductionVersion({ rank: 21, lastPublishedAt: daysAgo(400) }, longer, NOW),
    ).toBe(true);
  });
});

describe("preview promote window", () => {
  test("keeps an unreplaced preview promotable", () => {
    expect(
      isPreviewPromotable({ replacedAt: null }, DEFAULT_RETENTION_POLICY, NOW),
    ).toBe(true);
  });

  test("closes seven days after the replacement", () => {
    expect(
      isPreviewPromotable({ replacedAt: daysAgo(6.9) }, DEFAULT_RETENTION_POLICY, NOW),
    ).toBe(true);
    expect(
      isPreviewPromotable({ replacedAt: daysAgo(7) }, DEFAULT_RETENTION_POLICY, NOW),
    ).toBe(false);
  });
});
