import { describe, expect, test } from "vitest";
import { isClearedGenerationBaseline } from "../../src/repositories/generation-baseline-reset";

const versionCreatedAt = new Date("2026-01-01T00:00:00.000Z");

describe("generation baseline reset eligibility", () => {
  test("keeps every baseline eligible when the cache was never cleared", () => {
    expect(
      isClearedGenerationBaseline({
        versionCreatedAt,
        generationBaselineResetAt: null,
      }),
    ).toBe(false);
  });

  test("rejects a version created before the cache was cleared", () => {
    expect(
      isClearedGenerationBaseline({
        versionCreatedAt,
        generationBaselineResetAt: new Date(
          versionCreatedAt.getTime() + 1,
        ),
      }),
    ).toBe(true);
  });

  test("rejects a version created in the same instant as the clear", () => {
    expect(
      isClearedGenerationBaseline({
        versionCreatedAt,
        generationBaselineResetAt: versionCreatedAt,
      }),
    ).toBe(true);
  });

  test("accepts a version published after the clear so reuse resumes on its own", () => {
    expect(
      isClearedGenerationBaseline({
        versionCreatedAt,
        generationBaselineResetAt: new Date(
          versionCreatedAt.getTime() - 1,
        ),
      }),
    ).toBe(false);
  });
});
