/**
 * Doxa Agent — public package entrypoint.
 *
 * The implementation is split into focused modules so this agent can be
 * exported as a standalone package without depending on top-level CLI prompt
 * directories.
 */

export { analyzeProjectOnly, analyzeProjectWithCacheState, suggestStructure } from "./analysis-service";
export type { ProjectAnalysisWithCacheState } from "./analysis-service";
export {
  baselinePageInputHashes,
  buildPageInputHashMap,
  generateDocumentation,
  generateTestPages,
} from "./generation-service";
export { StructureGenerationFailedError } from "./structure-runner";
export {
  pageRoutesById,
  seedStructureFromSite,
  seedTextForPages,
  type SeedNavigationNode,
  type SeedPage,
  type SeedSection,
} from "./seed-structure";
export {
  StructureReviewFailedError,
  applyStructureReviewDecisions,
  editorialPageCount,
  reviewDocumentationStructure,
  reviewStructureWithRetry,
  summarizeStructureReviewDecisions,
  validateReviewedStructure,
} from "./structure-review";
export type {
  StructureReviewDecision,
  StructureReviewDecisionSummary,
  StructureReviewInput,
  StructureReviewOperations,
} from "./structure-review";
export {
  StructureInfeasibleConstraintsError,
  StructurePipelineDefectError,
} from "./structure-review-errors";
export type { StructureFailureKind } from "./structure-review-errors";
export {
  MAX_PROJECT_CONTEXT_LENGTH,
  PUBLIC_DOCUMENTATION_POLICY_VERSION,
  NO_PROJECT_INSTRUCTIONS_FINGERPRINT,
  documentationBriefFingerprint,
  projectInstructionsFingerprint,
  resolveDocumentationBrief,
  resolveDocumentationPolicy,
} from "./documentation-policy";
export type { PublicDocumentationPolicy } from "./documentation-policy";
export { applyReferenceInstructions } from "./reference-instructions";
export { keepPublishedRoutes } from "./published-routes";
export { PageValidationExhaustedError, runWriterAttempts } from "./writer-pipeline";
export { DEFAULT_WRITER_MAX_STEPS } from "./constants";
export { resolveWriterMaxSteps } from "./writer";
export {
  flattenStructure,
  slugify,
  stablePageId,
  validateGlobalPageIds,
} from "./structure-utils";
export type { FlattenedStructurePage } from "./structure-utils";
export {
  WRITER_HANDOFF_VERSION,
  buildWriterHandoff,
  formatWriterHandoffForPrompt,
  formatWriterHandoffPageForPrompt,
  formatWriterHandoffSharedForPrompt,
  selectWriterPageBriefs,
} from "./writer-handoff";
export type {
  WriterHandoffManifest,
  WriterHandoffPageBrief,
  WriterHandoffSourceEvidence,
} from "./writer-handoff";
export {
  DEFAULT_SECTION_FOLDER,
  buildRouteRegistry,
  pageOutputPath,
  rewriteInternalLinks,
  routeFromOutputPath,
  routeRegistrySummary,
  sectionFolder,
} from "./route-registry";
export {
  detectProjectProfile,
  formatDetectedSurfaces,
  validateDocumentationStructureForProfile,
} from "./prompts";
export {
  DocsQualityValidationError,
  PageGenerationAbortedError,
  TestPageGenerationError,
} from "./errors";
export type { TestPageFailure } from "./errors";
export {
  NAV_ORDER_MANIFEST_FILENAME,
  applyNavOrderManifest,
  buildDeterministicNavOrderManifest,
  readNavOrderManifest,
} from "./nav-order";
export {
  DEFAULT_REFERENCE_SECTION_DEFAULTS,
  ensureReferenceSections,
  referenceIdentityKey,
  referenceSectionDefaultsFromAnswers,
  sectionConfigForStructure,
} from "./reference-surfaces";
export type {
  DocLike,
  NavOrderGroup,
  NavOrderManifest,
  NavOrderSection,
} from "./nav-order";
export type { ReferenceSectionDefaults, ReferenceSectionOptions } from "./reference-surfaces";
export {
  DEFAULT_REST_API_DOCS_POLICY,
  isRestApiPlaygroundEnabled,
  resolveRestApiRuntimeFeatures,
  resolveRestApiDocsPolicy,
} from "./rest-api-policy";
export type {
  RestApiDocsPolicy,
  RestApiPageTitles,
} from "./rest-api-policy";

// Re-export all types so consumers can import from doxa-agent.
export type {
  AgentConfig,
  ProjectAnalysis,
  DocumentationStructure,
  AgentProgressCallback,
  AgentProgressEvent,
  PageFailureAction,
  PageFailureDecisionHandler,
  PageGenerationFailure,
  StructureSuggestionInput,
  GeneratedPageContent,
  GenerationResult,
  GenerationExecutionOptions,
  WriterContext,
  ProjectReferenceSurfaces,
  RestApiReferenceEndpoint,
  RestApiReferenceParameter,
  RestApiReferenceField,
  RestApiReferenceResponse,
  RestApiReferenceAuth,
  RestApiReferenceSurface,
  RestApiReferenceGroup,
  SdkApiReferenceExport,
  SdkApiReferenceModule,
  PageReferenceMetadata,
  PageDependencyState,
  DocumentationTarget,
  DocumentationGenerationBrief,
  ResolvedDocumentationGenerationBrief,
  PublicEditorialBrief,
  WriterExplorationMode,
} from "../types";
export {
  buildPageEvidenceBundle,
  buildSourceEvidenceContext,
} from "./evidence-bundle";
export type { PageEvidenceBundle } from "./evidence-bundle";
export { deterministicPageRendererFor } from "./deterministic-pages";
export { templateRenderedPageIds } from "./page-renderer-kind";
