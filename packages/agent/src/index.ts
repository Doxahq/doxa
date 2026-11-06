export * from "./build-info";
export * from "./cache";
export * from "./types";
export * from "./adapters";
export * from "./core";
export * from "./doxa-agent";
export * from "./doxa";
export * from "./repo-map";
export * from "./reference-specs";
export * from "./utils/hash";
export * from "./utils/adaptive-concurrency";
export * from "./utils/frontmatter";
export * from "./utils/page-validator";
export * from "./utils/docs-quality-validator";
export * from "./utils/component-allowlist";
export * from "./utils/writer-validation-config";
export * from "./utils/analysis-normalizer";
export * from "./utils/mdx-compile";
export {
  acquireSharedMdxValidatorPool,
  createMdxValidatorPool,
  disposeMdxValidatorPool,
  getSharedMdxValidatorPool,
  releaseSharedMdxValidatorPool,
} from "./utils/mdx-validator-pool";
export type {
  MdxValidatorChildProcess,
  MdxValidatorPool,
  MdxValidatorPoolOptions,
  MdxValidatorSpawn,
} from "./utils/mdx-validator-pool";
export * from "./utils/mdx-repair";
export * from "./doxa-agent/mdx-repair-model";

export {
  EMPTY_SOURCE_CHANGES,
  createDocsPlanningContext,
  buildAnalysisHash,
  buildPageInputHash,
  buildPageInputHashes,
  buildStructureHash,
  buildStructuralFingerprint,
  filterSourceChanges,
  hasSourceChanges,
  mergeSourceChanges,
  planDocsGeneration,
  planPagesAgainstBaseline,
  planRevisionAwareGeneration,
  canPatchStructure,
  MAX_STRUCTURE_PATCH_CHANGES,
  planPageEdits,
  applyInstructionEdits,
  catchUpInstructionPages,
  instructionCatchUpEdits,
  pagesBehindInstructions,
  runInstructionsChanged,
  runInstructionsFingerprint,
  isDocumentationStructure,
  evidencePaths,
  normalizedBrief,
  isDocsConfigPath,
  isDocumentationRelevantSourcePath,
  isPackageManifestPath,
  isStructuralSourcePath,
  sourceChangePaths,
  sourceChangeCount,
} from "./state";
export type {
  AgentRunState,
  AnalysisState,
  DocsGenerationPlan,
  DocsManifest,
  PageEdit,
  PageTarget,
  PriorRevisionGenerationState,
  RevisionAwareGenerationPlan,
  RevisionSourceChange,
  SourceCheckpoint,
} from "./state";
