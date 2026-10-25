import {
  DEFAULT_DOXA_PLANNER_MODEL,
  DEFAULT_DOXA_WRITER_MODEL,
  PLANNING_FINGERPRINT_VERSION,
  WRITER_HANDOFF_CONTRACT_VERSION,
  WRITING_FINGERPRINT_VERSION,
  type GenerationExecutionConfig,
} from "@doxahq/contracts";
import type { Env } from "../env";

const DEFAULT_GENERATOR_FINGERPRINT_VERSION = "doxabot-v2";

type GenerationExecutionConfigEnv = Pick<
  Env,
  | "DOXABOT_GENERATOR_FINGERPRINT"
  | "DOXA_AGENT_MODEL"
  | "DOXA_PLANNER_MODEL"
  | "DOXA_WRITER_MODEL"
  | "DOXA_GENERATION_PROFILE"
>;

export function resolveGenerationExecutionConfig(
  env: GenerationExecutionConfigEnv,
): GenerationExecutionConfig {
  const legacyModel = env.DOXA_AGENT_MODEL?.trim();
  const plannerModel =
    env.DOXA_PLANNER_MODEL?.trim() ||
    legacyModel ||
    DEFAULT_DOXA_PLANNER_MODEL;
  const writerModel =
    env.DOXA_WRITER_MODEL?.trim() ||
    legacyModel ||
    DEFAULT_DOXA_WRITER_MODEL;
  const generationProfile =
    env.DOXA_GENERATION_PROFILE ?? "fast-mvp";
  const configured =
    env.DOXABOT_GENERATOR_FINGERPRINT?.trim();

  const planningFingerprint = [
    PLANNING_FINGERPRINT_VERSION,
    generationProfile,
  ].join(":");
  const writingFingerprint = [
    WRITING_FINGERPRINT_VERSION,
    writerModel,
    WRITER_HANDOFF_CONTRACT_VERSION,
  ].join(":");

  return {
    plannerModel,
    writerModel,
    generationProfile,
    planningFingerprint,
    writingFingerprint,
    generatorFingerprint:
      configured ||
      [
        DEFAULT_GENERATOR_FINGERPRINT_VERSION,
        planningFingerprint,
        writingFingerprint,
      ].join(":"),
  };
}
