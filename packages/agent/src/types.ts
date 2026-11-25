/**
 * Agent Types
 *
 * Single canonical home for every type the agent module exposes:
 *
 *  1. Doc-domain types — `DocPage`, `DocSection`,
 *     `DocumentationStructure`, `ProjectAnalysis`, `WriterContext`, etc.
 *     These describe the dynamic-structure pipeline driven by `doxa-agent`
 *     and are consumed by prompts/, commands/, cli/, and dev/.
 *
 *  2. Template-generation types — `FileInfo`, `GeneratedDoc`,
 *     `AgentProgress`, `ProgressCallback`. These support
 *     {@link TemplateGenerator} and the shared {@link ProgressDisplay}
 *     UI component.
 */

import type { PlannedPageType } from "./utils/planned-page-types";
import type { DoxabotPageType, GenerationInstructions, ModelProvider, ReferenceSourceReport } from "@doxahq/contracts";
import type { SpecReaderInput } from "@doxahq/contracts/spec-reader";
import type { PageOpenIssue } from "@doxahq/contracts/generation-reviews";
import type {
  AgentLoopTermination,
  AgentSpanCallback,
  AgentUsageCallback,
  ModelCallRetryEvent,
  PromptCacheSetting,
  Provider,
} from "./core";
import type { RepoMapOptions } from "./repo-map";
import type { ConcurrencyLimiter } from "./utils/adaptive-concurrency";

// ─── Doc-Domain Types ──────────────────────────────────────────────────

export type ReferenceSurfaceKind = "rest" | "sdk";

export type SdkReferenceExportKind =
  | "function"
  | "class"
  | "type"
  | "interface"
  | "hook"
  | "constant"
  | "component"
  | "module"
  | "other";

export interface PageReferenceMetadata {
  kind: ReferenceSurfaceKind;
  pageKind?: "endpoint" | "group" | "overview" | "auth";
  groupId?: string;
  endpointId?: string;
  moduleId?: string;
  exportId?: string;
  method?: string;
  path?: string;
  exportName?: string;
  exportKind?: SdkReferenceExportKind;
  /**
   * REST endpoint pages only: the hash of every fact the endpoint template
   * renders. It is part of the page input hash, so a changed parameter,
   * field or response writes that endpoint page again, and only that page.
   */
  factsHash?: string;
}

/** A documentation page. Pages are always direct children of a section. */
export interface DocPage {
  id: string;
  title: string;
  description: string;
  /** Optional navigation group inside the section. This is presentation only. */
  group?: string;
  /** Source files and facts that should be used when writing this page. */
  sourceEvidence?: SourceEvidence[];
  /** Collection represented by this page, when generated from a detected collection. */
  collectionId?: string;
  /** Collection item represented by this page, when generated from a detected collection. */
  collectionItemId?: string;
  /** Intended reader for this page. Defaults to "consumer". */
  audience?: "consumer" | "maintainer" | "reference";
  /** Whether this page should be visible in generated nav. Defaults to "visible". */
  navVisibility?: "visible" | "hidden";
  /** Canonical route if known. Writers must use generated routes otherwise. */
  canonicalRoute?: string;
  /** Internal terms or paths explicitly allowed on this page. */
  allowedInternalTerms?: string[];
  /** Structured reference metadata used by writers and reference navigation. */
  reference?: PageReferenceMetadata;
  /** What the planner calls this page. A page of a type that the owner turned off is removed. */
  pageType?: PlannedPageType;
}

/** A documentation section (groups pages). */
export interface DocSection {
  id: string;
  title: string;
  pages: DocPage[];
  /**
   * When true, this section is the rootless/default section. Exactly one
   * section in a {@link DocumentationStructure} should set this. The writer
   * emits the default section's pages under `default/` on disk; the
   * docs-template reader resolves them via `default/<slug>/index.mdx` with a
   * fallback to the legacy rootless layout.
   */
  default?: boolean;
}

/** The complete documentation structure proposed by the agent. */
export interface DocumentationStructure {
  sections: DocSection[];
}

export interface SourceEvidence {
  /** Project-relative source file path. */
  path: string;
  /** Why this file is relevant to the generated page. */
  kind?: "docs" | "readme" | "package" | "source" | "manifest" | "example" | "other";
  /** Optional human-readable label for prompt display. */
  title?: string;
}

export interface PageDependencyState {
  sourceFilesRead: string[];
  sourceFilesDiscovered: string[];
  sourceEvidenceFiles: string[];
  referencedSymbols: string[];
  referencedRoutes: string[];
}

export interface RestApiReferenceEndpoint {
  id: string;
  title: string;
  method: string;
  path: string;
  description: string;
  auth?: string;
  requestSchema?: string;
  responseSchema?: string;
  errors?: string[];
  parameters?: RestApiReferenceParameter[];
  bodyFields?: RestApiReferenceField[];
  bodyContentType?: string;
  responses?: RestApiReferenceResponse[];
  authRequirement?: RestApiReferenceAuth;
  /** The spec marks the endpoint deprecated. */
  deprecated?: boolean;
  sourceEvidence: SourceEvidence[];
}

export interface RestApiReferenceParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  type: string;
  required: boolean;
  description?: string;
  example?: string;
  enumValues?: string[];
}

export interface RestApiReferenceField {
  /** Dotted path for nested fields, e.g. "author.name". */
  name: string;
  type: string;
  required: boolean;
  description?: string;
  example?: string;
}

export interface RestApiReferenceResponse {
  status: number;
  /** The status key of a spec response that is not one code: `2XX` or `default`. */
  statusLabel?: string;
  contentType?: string;
  description?: string;
  /** JSON string, pretty-printed. */
  example?: string;
  fields?: RestApiReferenceField[];
}

export interface RestApiReferenceAuth {
  scheme: "bearer" | "apiKey" | "basic" | "oauth2" | "none";
  location?: "header" | "query" | "cookie";
  name?: string;
  description?: string;
}

export interface RestApiReferenceGroup {
  id: string;
  title: string;
  description?: string;
  sourceEvidence: SourceEvidence[];
  endpoints: RestApiReferenceEndpoint[];
}

export interface SdkApiReferenceExport {
  id: string;
  name: string;
  kind: SdkReferenceExportKind;
  description: string;
  signature?: string;
  importPath?: string;
  sourceEvidence: SourceEvidence[];
}

export interface SdkApiReferenceModule {
  id: string;
  title: string;
  description?: string;
  packageName?: string;
  importPath?: string;
  sourceEvidence: SourceEvidence[];
  exports: SdkApiReferenceExport[];
}

export interface ReferenceSurfaceSection {
  label?: string;
  slug?: string;
  description?: string;
  sourceEvidence: SourceEvidence[];
}

/** Where a REST surface came from, when code read it from spec files. */
export interface RestApiReferenceSource {
  kind: "openapi";
  /** The version text of each spec, such as `3.1.0`, in file order. */
  specVersions: string[];
  /** The root and referenced spec files, sorted. */
  files: string[];
  /** The SHA-256 of the text of the spec files. */
  contentHash: string;
  /** The SHA-256 of the spec-reader bundle. */
  readerVersion: string;
}

export interface RestApiReferenceSurface extends ReferenceSurfaceSection {
  /** Set when the surface comes from spec files instead of the model. */
  source?: RestApiReferenceSource;
  baseUrl?: string;
  servers?: string[];
  /** Auth schemes shared by the endpoints of this surface. */
  authSchemes?: RestApiReferenceAuth[];
  /** Set by analysis when the endpoints cannot answer a browser request. */
  playground?: { enabled: boolean; reason?: string };
  groups: RestApiReferenceGroup[];
}

export interface SdkApiReferenceSurface extends ReferenceSurfaceSection {
  modules: SdkApiReferenceModule[];
}

export interface ProjectReferenceSurfaces {
  /** HTTP/RPC/webhook endpoints served by the project. */
  rest?: RestApiReferenceSurface;
  /** Public SDK/library/framework exports consumed by developers. */
  sdk?: SdkApiReferenceSurface;
}

export interface DocumentationCollectionItem {
  id: string;
  title: string;
  slug: string;
  description?: string;
  packageName?: string;
  installCommand?: string;
  sourceEvidence: SourceEvidence[];
}

/** A file under `docs/` in the repository. */
export interface RepositoryDocument {
  path: string;
  title: string;
}

export interface DocumentationCollection {
  id: string;
  title: string;
  description?: string;
  kind: "docs" | "package" | "manifest" | "mixed";
  sourceEvidence: SourceEvidence[];
  items: DocumentationCollectionItem[];
  /**
   * How many items the project instructions removed because their page type
   * is off. They still count toward the collection minimum, so removing one
   * item never takes away the pages of the others. Code sets it; the
   * analysis model cannot (the instructions step overwrites it).
   */
  turnedOffItemCount?: number;
}

/**
 * Analysis data from project exploration (without structure suggestion).
 * Used as intermediate data before asking user questions.
 */
export interface ProjectAnalysis {
  projectName: string;
  projectType: string;
  languages: string[];
  frameworks: string[];
  entryPoints: string[];
  keyFiles: string[];
  summary: string;
  /** Longer project description — full understanding of purpose and capabilities. */
  projectDescription: string;
  /** Standardized project category for tailoring docs generation. */
  projectCategory:
    | "cli"
    | "api"
    | "web-app"
    | "library"
    | "platform"
    | "mobile-app"
    | "desktop-app"
    | "framework"
    | "monorepo"
    | "other";
  /** Prompt profile selected by the analysis stage. */
  projectProfile?:
    | "cli"
    | "api"
    | "web-app"
    | "docs-template"
    | "library"
    | "platform"
    | "framework"
    | "monorepo"
    | "application"
    | "fallback";
  /** Confidence score for the selected prompt profile. */
  profileConfidence?: number;
  /** File-backed evidence used to select the prompt profile. */
  profileEvidence?: string[];
  /** Public interfaces that should be documented directly. */
  publicInterfaces?: {
    cliCommands?: Array<{
      name: string;
      description: string;
      args?: string[];
      options?: string[];
      example?: string;
    }>;
    apiEndpoints?: Array<{
      method: string;
      path: string;
      description: string;
    }>;
    exports?: string[];
    routes?: string[];
  };
  /** Internal development tooling that should not become one-page-per-item docs. */
  internalTooling?: {
    packageScripts?: string[];
    buildTools?: string[];
  };
  /**
   * Documentation intent inferred at the analysis boundary. Defaults to
   * consumer/adopter docs, even when the source repo is a monorepo.
   */
  documentationIntent?: {
    audience: "consumer" | "maintainer" | "mixed";
    primaryUseCase: string;
    publicPackageNames: string[];
    canonicalWorkflows: Array<{
      name: string;
      framework?: string;
      installCommands: string[];
      requiredFiles: string[];
      canonicalImports: string[];
      envVars: string[];
      routePaths: string[];
      verificationSteps: string[];
      sourceEvidence: string[];
    }>;
    internalOnlyPaths: string[];
    consumerTerminology: string[];
  };
  /** Safe editorial guidance extracted from optional project context. */
  publicEditorialBrief?: PublicEditorialBrief;
  /** Detected features for dynamic questions. */
  isMonorepo: boolean;
  hasReact: boolean;
  hasApiRoutes: boolean;
  hasCli: boolean;
  /** Detected packages (for monorepos). */
  packages: Array<{ name: string; description: string }>;
  /** CLI commands with args, options, and descriptions. */
  cliCommands: Array<{
    name: string;
    description: string;
    args?: string[];
    options?: string[];
    example?: string;
  }>;
  /** Configuration files and their schemas. */
  configFiles: Array<{
    path: string;
    description: string;
    schema?: string;
  }>;
  /** API endpoints discovered in the project. */
  apiEndpoints: Array<{
    method: string;
    path: string;
    description: string;
  }>;
  /** High-level feature list. */
  keyFeatures: string[];
  /** Installation methods (npm, bun, curl, docker, etc.). */
  installMethods: string[];
  /** External integrations (cloud providers, APIs, services). */
  externalIntegrations: string[];
  /** Repeated user-facing docs/product surfaces that need coverage. */
  documentationCollections?: DocumentationCollection[];
  /** The repository's own docs files: evidence for the planner, not a list of pages. */
  repositoryDocuments?: RepositoryDocument[];
  /** Structured public API surfaces that deserve dedicated reference sections. */
  referenceSurfaces?: ProjectReferenceSurfaces;
  /** Where the REST reference came from, and why when it did not come from a spec. */
  referenceSourceReport?: ReferenceSourceReport;
}

export type {
  ReferenceFileIssue,
  ReferenceSkippedOperation,
  ReferenceSourceReport,
  ReferenceSourceStatus,
  ReferenceSpecReport,
} from "@doxahq/contracts";

/**
 * Runs the spec-reader utility job for one run. The agent container gives a
 * client that calls the job in its own container, or a local child in
 * development.
 */
export interface SpecReaderClient {
  /** One job call. A failure means the call did not finish, not that a spec failed. */
  read(input: SpecReaderInput): Promise<SpecReaderCallResult>;
  /** Ends the job instance of the run. */
  done(): Promise<void>;
}

export type SpecReaderCallResult =
  | { ok: true; output: unknown }
  | { ok: false; code: string; message: string };

/**
 * Result from project analysis with suggested structure.
 * Generated after user answers questions.
 */
export interface ProjectAnalysisResult {
  projectName: string;
  projectType: string;
  languages: string[];
  frameworks: string[];
  entryPoints: string[];
  keyFiles: string[];
  summary: string;
  suggestedStructure: DocumentationStructure;
}

/** User answers paired with analysis for structure suggestion. */
export interface StructureSuggestionInput {
  analysis: ProjectAnalysis;
  answers: Record<string, unknown>;
  documentationBrief?: DocumentationGenerationBrief;
  /** Published structure from the baseline version, used to keep page identity stable across regenerations. */
  publishedStructure?: DocumentationStructure;
  /** Source paths changed since the baseline, so the model only revises what moved. */
  changedSourcePaths?: string[];
  /** The project instructions changed since the baseline, so published pages may change to follow them. */
  instructionsChanged?: boolean;
  /** Editorial budget for guide, concept, and workflow pages. */
  maxPages?: number;
  /** Validation feedback from a previous exhausted structure run, used for manual retries. */
  initialValidationErrors?: string[];
  /** Receives the planned pages that the project instructions removed from the accepted plan. */
  onPlanRemovals?: (removed: readonly PlanRemoval[]) => void;
}

/** Why the project instructions removed a page that the planner proposed. */
export type PlanRemovalReason =
  | { kind: "page_type"; pageType: DoxabotPageType }
  | { kind: "excluded_evidence" };

/** A planned page that the project instructions removed. */
export interface PlanRemoval {
  title: string;
  reason: PlanRemovalReason;
}

/** Progress event emitted by the agent during long-running operations. */
export interface AgentProgressEvent {
  stage: "analyzing" | "proposing" | "gathering" | "writing" | "ordering" | "complete" | "error";
  message: string;
  progress: number;
  currentItem?: string;
}

export type AgentProgressCallback = (event: AgentProgressEvent) => void;

export type PageFailureAction = "retry" | "skip" | "abort";

export interface PageGenerationFailure {
  pageId: string;
  title: string;
  sectionTitle: string;
  outputPath: string;
  reason: string;
  attemptLimit: number;
  retryCount: number;
  /** True when no retry is left, so the handler can only skip or abort. */
  retryBudgetExhausted?: boolean;
}

export interface DocsQualityIssue {
  rule: string;
  severity: "error" | "warning";
  title?: string;
  route?: string;
  line?: number;
  message: string;
  excerpt?: string;
}

export interface DocsQualityReport {
  ok: boolean;
  issues: DocsQualityIssue[];
}

export interface DocsQualityValidationConfig {
  /** Default true for generated docs and dev harness runs. */
  enabled?: boolean;
  /** Default "consumer". */
  audience?: "consumer" | "maintainer" | "mixed";
  /** Treat warnings as errors. Default false. */
  failOnWarnings?: boolean;
  /** Maximum page repair/skip decisions after a failed whole-doc validation. Default 3. */
  maxRepairAttempts?: number;
  /** Maximum whole-doc quality rewrites for the same page. Default 2. */
  maxRepairAttemptsPerPage?: number;
}

/** Public documentation is the only generation target supported today. */
export type DocumentationTarget = { kind: "public" };

/** Optional task-wide guidance supplied by the project owner. */
export interface DocumentationGenerationBrief {
  target: DocumentationTarget;
  projectContext?: string;
  /** The Doxabot instructions saved for the project, already validated by the API. */
  projectInstructions?: GenerationInstructions;
}

/** A normalized generation brief with the public target made explicit. */
export interface ResolvedDocumentationGenerationBrief {
  target: DocumentationTarget;
  projectContext?: string;
  projectInstructions?: GenerationInstructions;
}

/** Editorial guidance extracted from optional project context during analysis. */
export interface PublicEditorialBrief {
  productPositioning?: string;
  intendedReaders: string[];
  readerGoals: string[];
  focusAreas: string[];
  deprioritizedAreas: string[];
  preferredTone?: string;
  preferredTerminology: string[];
}

export type PageFailureDecisionHandler = (
  failure: PageGenerationFailure
) => Promise<PageFailureAction> | PageFailureAction;

export type AgentToolPolicy = "read_only" | "local_shell";

interface WriterDiagnosticBase {
  pageTitle: string;
  pageRetry: number;
  attempt: number;
  maxAttempts: number;
}

export type WriterDiagnosticEvent =
  | (WriterDiagnosticBase & {
      eventType: "writer_attempt_started";
      maxTokens: number;
    })
  | (WriterDiagnosticBase & {
      eventType: "writer_model_completed";
      durationMs: number;
      rawChars: number;
      finishReason?: string;
      steps?: number;
      loopTermination?: AgentLoopTermination;
      finalizationTriggered?: boolean;
      repeatedToolCallsBlocked?: number;
    })
  | (WriterDiagnosticBase & {
      eventType: "writer_model_failed";
      durationMs: number;
      errorName: string;
      errorMessage: string;
    })
  | (WriterDiagnosticBase & {
      eventType: "writer_validation_completed";
      durationMs: number;
      bodyChars: number;
      issueCodes: string[];
      hardIssueCount: number;
      willRetry: boolean;
    })
  | (WriterDiagnosticBase & {
      /** The page was kept with soft issues after its last attempt. */
      eventType: "writer_accepted_with_issues";
      issueCodes: string[];
      /** The issues that break the project owner's instructions. */
      instructionIssueCodes: string[];
    });

export type WriterDiagnosticCallback = (event: WriterDiagnosticEvent) => void;

export interface WriterRepairDiagnostic {
  pageId: string;
  pageTitle: string;
  pageRetry: number;
  writerAttempt: number;
  attempt: number;
  maxAttempts: number;
  rule: string;
  message: string;
  line?: number;
  column?: number;
  snippet?: string;
  draft: string;
  repairKind: "model_patch";
  /** Validation class routed into the targeted model repair. */
  repairClass?: TargetedRepairClass;
  repairSucceeded: boolean;
  rejectionReason?: string;
  validationIssueCodes: string[];
}

export type WriterRepairDiagnosticCallback = (
  diagnostic: WriterRepairDiagnostic,
) => Promise<void> | void;

export type GeneratedPageCallback = (
  page: GeneratedPageContent,
) => Promise<void> | void;

/** Configuration for the doc-generation agent. */
export interface AgentConfig {
  /** The model API to call. Defaults to OpenRouter. */
  modelProvider?: ModelProvider;
  /** API key of `modelProvider`. */
  apiKey?: string;
  /** A short-lived Anthropic bearer token, in place of `apiKey`. Anthropic only. */
  authToken?: string;
  /** Model id — defaults to the agent's recommended model. */
  model?: string;
  /** Optional provider injection for tests and advanced embedded use. */
  provider?: Provider;
  /** Prompt caching for providers that support it. Defaults to the shared policy. */
  promptCache?: PromptCacheSetting;
  /** Working directory for the agent. */
  cwd: string;
  /**
   * Trusted root for generated documentation and writer diagnostics.
   * Hosted callers must keep this outside the untrusted repository checkout.
   * Defaults to `cwd` for local compatibility.
   */
  artifactRoot?: string;
  /** Explicitly allowed exploration capabilities for this invocation. */
  toolPolicy: AgentToolPolicy;
  /**
   * Code-built repository map for the planner. Built by default without a
   * cache; `false` turns it off and exploration runs without a map.
   */
  repoMap?: RepoMapOptions | false;
  /** Output directory for generated docs. */
  outputDir?: string;
  /** Number of concurrent page writers (default: 10). */
  concurrency?: number;
  /** Idle timeout between streamed chunks for a single model call. */
  modelCallTimeoutMs?: number;
  /** Absolute ceiling for a single model call, regardless of streaming activity. */
  modelCallMaxDurationMs?: number;
  /**
   * Controls whether writers can explore the repository or use a sufficient
   * preassembled evidence bundle. Defaults to "agentic".
   */
  writerExploration?: WriterExplorationMode;
  /**
   * Model turns of one agentic writer attempt, the forced final turn
   * included. Defaults to `DEFAULT_WRITER_MAX_STEPS`. A validation-only
   * writer keeps its fixed two turns.
   */
  writerMaxSteps?: number;
  /** Reports the exploration mode actually selected once for each page. */
  onWriterExplorationResolved?: WriterExplorationResolvedCallback;
  /**
   * MDX component reference for the writer prompt. Defaults to the bundled
   * copy of the template's agent/component-playbook.md.
   */
  componentPlaybook?: string;
  /** Per-page writer validation gate. Resolved in the CLI from flags + env. */
  writerValidation?: WriterValidationConfig;
  /** Called when a page exhausts writer attempts. Defaults to skipping the page. */
  onPageFailure?: PageFailureDecisionHandler;
  /**
   * Called for whole-document quality failures. Falls back to onPageFailure
   * for backward compatibility when omitted.
   */
  onDocsQualityFailure?: PageFailureDecisionHandler;
  /** Maximum retries after a page exhausts its writer attempts. Default 1. */
  pageFailureMaxRetries?: number;
  /**
   * Model for the last retry of a failing page, with the same provider. The
   * page keeps the model that wrote it in its usage records.
   */
  writerFallbackModel?: string;
  /** How many failed pages retry at once. Default 1, which keeps prompts in order. */
  pageRetryConcurrency?: number;
  /**
   * Shared, adaptive limit on page writers. Every page write takes a slot,
   * so concurrent page batches of one job share the width. Without it,
   * `concurrency` is a fixed width.
   */
  pageWriterLimiter?: ConcurrencyLimiter;
  /** Runs the spec-reader job. Without it, the REST reference comes from the model. */
  specReader?: SpecReaderClient;
  /** Spec files named in the project settings. Discovery then reads only these. */
  restApiSpecPaths?: string[];
  /** Called before each model call retry, for example to lower the writer width. */
  onModelCallRetry?: (retry: ModelCallRetryEvent) => void;
  /** Whole-docs validation gate run before nav/materialization. */
  docsQuality?: DocsQualityValidationConfig;
  /** Public target and optional project-wide editorial guidance. */
  documentationBrief?: DocumentationGenerationBrief;
  /** Cancels model streams and tool execution when the owning request ends. */
  abortController?: AbortController;
  /** Emits operational writer diagnostics without adding generation progress events. */
  onWriterDiagnostic?: WriterDiagnosticCallback;
  /** Emits request-scoped provider usage for durable hosted cost telemetry. */
  onModelUsage?: AgentUsageCallback;
  /** Emits request-scoped latency spans for stage performance telemetry. */
  onSpan?: AgentSpanCallback;
  /** Emits bounded failed drafts and exact MDX parser diagnostics. */
  onRepairDiagnostic?: WriterRepairDiagnosticCallback;
  /** Emits each validated page as soon as it is safe to checkpoint. */
  onPageGenerated?: GeneratedPageCallback;
}

/**
 * Writer correctness-gate config. Same surface used by the in-loop
 * `validate_page` tool and the server-side gate in `runWriterAttempts`.
 *
 * Resolution order in the CLI: CLI flags → environment variables → defaults.
 */
export interface WriterValidationConfig {
  /** Per-page validation/retry attempts. Default 3. */
  maxAttempts: number;
  /** Run the MDX subprocess parse pass. Default true. */
  mdxCompile: boolean;
  /** Subprocess timeout in ms for the MDX pass. Default 10000. */
  timeoutMs: number;
  /**
   * Validation classes eligible for targeted model repair before a full
   * page regeneration. Default: `["mdx"]`.
   */
  targetedRepairClasses?: TargetedRepairClass[];
  /**
   * Exact values that no page may contain: the credentials of this run and
   * other secret environment values. The page gate rejects a page with one.
   */
  forbiddenValues?: readonly string[];
}

export type TargetedRepairClass =
  | "mdx"
  | "frontmatter"
  | "length";

export const DEFAULT_WRITER_VALIDATION: WriterValidationConfig = {
  maxAttempts: 3,
  mdxCompile: true,
  timeoutMs: 10_000,
  targetedRepairClasses: ["mdx"],
};

export type WriterExplorationMode = "agentic" | "evidence_first";

export type ResolvedWriterExplorationMode =
  | "evidence_first"
  | "agentic_fallback";

export interface WriterExplorationResolvedEvent {
  pageId: string;
  mode: ResolvedWriterExplorationMode;
}

export type WriterExplorationResolvedCallback = (
  event: WriterExplorationResolvedEvent,
) => void;

/** Context passed to the documentation writer for rich content generation. */
export interface WriterContext {
  /** Full project analysis data. */
  analysis: ProjectAnalysis;
  /** User answers from the question flow. */
  answers: Record<string, unknown>;
  /** Task-wide public target and optional owner guidance. */
  documentationBrief?: DocumentationGenerationBrief;
  /** The complete documentation structure (for cross-referencing). */
  structure: DocumentationStructure;
  /** Accepted planner output for the assigned writing batch. */
  writerHandoff?: import("./doxa-agent/writer-handoff").WriterHandoffManifest;
  /**
   * The hand-written text of pages in a seeded first generation, by stable
   * page ID. The writer keeps what the source confirms.
   */
  seedPages?: Readonly<Record<string, string>>;
  /**
   * The published versions of pages that the run edits instead of writing
   * again, by stable page ID. The writer changes only what the changed
   * files make wrong or incomplete.
   */
  previousPages?: Readonly<Record<string, PreviousPage>>;
}

/** The published version of a page, and the changed files that the page depends on. */
export interface PreviousPage {
  /** The published MDX page, with or without frontmatter. */
  content: string;
  /** The changed source files that the page depends on. Empty when only its brief changed. */
  changedSources: readonly string[];
  /** The project instructions changed: update the page to follow them. */
  instructionsChanged?: boolean;
}

/** A single generated page. */
export interface GeneratedPageContent {
  id: string;
  path: string;
  title: string;
  content: string;
  dependencies: PageDependencyState;
  contentHash: string;
  pageInputHash: string;
  /** Issues the writer could not fix before it kept the page. */
  openIssues?: PageOpenIssue[];
  /** Outside domains that the page links to and the repository does not contain. */
  unverifiedExternalDomains?: string[];
}

/** Final result of documentation generation. */
export interface GenerationResult {
  pages: GeneratedPageContent[];
  totalPages: number;
  outputDir: string;
  failedPages: PageGenerationFailure[];
  skippedPages: PageGenerationFailure[];
  qualityReport?: DocsQualityReport;
}

/** Optional controls used by durable hosted generation to write one checkpointed page batch. */
export interface GenerationExecutionOptions {
  /** Stable page IDs to generate from the full structure. */
  pageIds?: string[];
  /** Run whole-document pruning and navigation finalization. Defaults to true. */
  finalize?: boolean;
}

/**
 * Section descriptor written into `src/contents/settings/sections.json` and
 * mirrored at runtime by the docs-template's `src/settings/sections.ts`
 * loader. Exactly one entry must set `default: true`. Keep the shape in
 * sync with the docs-template's `SectionConfig` interface.
 */
export interface SectionConfig {
  /** Kebab-case slug. Doubles as the on-disk folder name for non-default sections. */
  slug: string;
  /** Tab/heading label shown in the docs UI. */
  label: string;
  /** Optional description for SEO / future tooltips. */
  description?: string;
  /** Optional icon key (resolved against the docs-template's icon map). */
  icon?: string;
  /** Exactly one section must set this. The default section's URLs are rootless. */
  default?: boolean;
  /** Hide the section's tab without removing its content. */
  hidden?: boolean;
  /** Optional section behavior hint consumed by the docs template. */
  kind?: "documentation" | "reference" | "development";
  /** Optional layout hint consumed by the docs template. */
  layout?: "docs" | "reference";
}

// ─── Template-Generation Types ─────────────────────────────────────────

/** Metadata + content for a single source file scanned by the analyzer. */
export interface FileInfo {
  path: string;
  relativePath: string;
  content: string;
  extension: string;
  size: number;
}

/**
 * A finished doc artifact written to disk by {@link TemplateGenerator}.
 * Sections describe ordered chunks within a single MDX file.
 */
export interface GeneratedDoc {
  filename: string;
  title: string;
  content: string;
  /** Optional nav/frontmatter icon key from the docs template icon catalog. */
  icon?: string;
  /** Optional compact sidebar label. Must be 1-3 plain-text words. */
  navTitle?: string;
  /** Optional compact reference badge shown in reference sidebars. */
  navBadge?: string;
  sections: Array<{
    title: string;
    content: string;
    order: number;
  }>;
}

/**
 * Coarse-grained progress event consumed by {@link ProgressDisplay}.
 *
 * Distinct from {@link AgentProgressEvent}: this one drives the spinner +
 * progress bar UI surface and uses the legacy stage vocabulary that
 * predates the dynamic-structure agent.
 */
export interface AgentProgress {
  stage:
    | "scanning"
    | "analyzing"
    | "generating"
    | "writing"
    | "ordering"
    | "complete"
    | "error";
  message: string;
  /** 0-100. */
  progress: number;
  currentFile?: string;
}

export type ProgressCallback = (progress: AgentProgress) => void;
