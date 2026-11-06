import { describe, expect, test } from "vitest";
import {
  WRITER_HANDOFF_CONTRACT_VERSION,
  WRITING_FINGERPRINT_VERSION,
} from "@doxahq/contracts";
import { resolveGenerationExecutionConfig } from "../../src/services/generation-execution-config";

describe("generation execution config", () => {
  test("defaults to Sonnet 5.5 for planning and Haiku 5.5 for writing", () => {
    const config = resolveGenerationExecutionConfig({});

    expect(config.plannerModel).toBe("claude-sonnet-5-5");
    expect(config.writerModel).toBe("claude-haiku-5-5");
    expect(config.planningFingerprint).toBe(
      "doxabot-planning-v9:fast-mvp",
    );
    expect(config.writingFingerprint).toContain("claude-haiku-5-5");
  });

  test("preserves explicit planner and writer overrides", () => {
    const baseline = resolveGenerationExecutionConfig({});
    const config = resolveGenerationExecutionConfig({
      DOXA_PLANNER_MODEL: "custom/planner",
      DOXA_WRITER_MODEL: "custom/writer",
    });

    expect(config.plannerModel).toBe("custom/planner");
    expect(config.writerModel).toBe("custom/writer");
    expect(config.planningFingerprint).toBe(
      baseline.planningFingerprint,
    );
    expect(config.writingFingerprint).not.toBe(
      baseline.writingFingerprint,
    );
    expect(config.writingFingerprint).toBe(
      `${WRITING_FINGERPRINT_VERSION}:custom/writer:${WRITER_HANDOFF_CONTRACT_VERSION}`,
    );
  });

  test("changes planning identity for planning policy but not planner selection", () => {
    const baseline = resolveGenerationExecutionConfig({
      DOXA_PLANNER_MODEL: "planner/a",
      DOXA_GENERATION_PROFILE: "full-prod",
    });
    const differentPlanner = resolveGenerationExecutionConfig({
      DOXA_PLANNER_MODEL: "planner/b",
      DOXA_GENERATION_PROFILE: "full-prod",
    });
    const differentProfile = resolveGenerationExecutionConfig({
      DOXA_PLANNER_MODEL: "planner/b",
      DOXA_GENERATION_PROFILE: "fast-mvp",
    });

    expect(differentPlanner.planningFingerprint).toBe(
      baseline.planningFingerprint,
    );
    expect(differentProfile.planningFingerprint).not.toBe(
      baseline.planningFingerprint,
    );
  });
});
