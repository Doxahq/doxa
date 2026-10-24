import type {
  DocPage,
  DocumentationGenerationBrief,
  DocumentationStructure,
  PageReferenceMetadata,
  PreviousPage,
  ProjectAnalysis,
} from "../../../types";

export type PromptStage =
  | "exploration"
  | "analysis"
  | "structure"
  | "structure-review"
  | "writer"
  | "incremental-analysis"
  | "ordering";

export type ProjectProfileId =
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

export type ProjectCategory = ProjectAnalysis["projectCategory"];

export interface ProjectProfile {
  id: ProjectProfileId;
  label: string;
  categories: ProjectCategory[];
  description: string;
  explorationFocus: string[];
  analysisRules: string[];
  structureRules: string[];
  writerRules: string[];
}

export interface PromptRenderContext {
  cwd?: string;
  analysis?: ProjectAnalysis;
  answers?: Record<string, unknown>;
  structure?: DocumentationStructure;
  publishedStructure?: DocumentationStructure;
  sectionTitle?: string;
  page?: DocPage;
  pageType?: string;
  pageTypeInstructions?: string;
  descriptionInstructions?: string;
  relevantContext?: string;
  sourceEvidenceContext?: string;
  routeRegistryContext?: string;
  structureSummary?: string;
  writerHandoffSharedContext?: string;
  writerHandoffPageContext?: string;
  /** The page as the site owner wrote it, for a seeded first generation. */
  seedPageText?: string;
  /** The published version of a page that the writer edits, and the changed files behind the edit. */
  previousPage?: PreviousPage;
  writerExplorationMode?: "agentic" | "validation_only";
  includeWriterSharedContext?: boolean;
  componentPlaybook?: string;
  explorationContext?: string;
  /** Code-built repository map; stable for a source tree, so it belongs in the cached system prompt. */
  repoMap?: string;
  /** Where the REST endpoints come from, when not from the analysis answer. */
  restReference?: RestReferencePromptMode;
  previousAnalysis?: ProjectAnalysis;
  changedFiles?: string[];
  addedFiles?: string[];
  deletedFiles?: string[];
  fileContents?: string[];
  retryHint?: string;
  attempt?: number;
  validationErrors?: string[];
  maxPages?: number;
  orderingInput?: OrderingPromptInput;
  documentationBrief?: DocumentationGenerationBrief;
}

/**
 * `specFiles`: code read the REST surface from these spec files, so the
 * model leaves it out. `endpointExtraction`: a later step extracts endpoint
 * details from the route files, so the model lists groups, route files and
 * short endpoint lines only.
 */
export interface RestReferencePromptMode {
  specFiles?: string[];
  endpointExtraction?: boolean;
}

export interface OrderingSectionInput {
  slug: string;
  label: string;
  isDefault: boolean;
}

export interface OrderingDocInput {
  section: string;
  filename: string;
  title: string;
  head: string;
  group?: string;
  reference?: PageReferenceMetadata;
  referenceGroupHeading?: string;
  referenceGroupOrder?: number;
  referenceItemOrder?: number;
  /** Lucide icons that match the page, best first, offered beside the suggested icons. */
  iconCandidates?: readonly string[];
}

export interface OrderingPromptInput {
  sections: OrderingSectionInput[];
  docs: OrderingDocInput[];
  iconCatalog?: string;
}

export interface PromptModule {
  id: string;
  stage: PromptStage;
  priority: number;
  profiles?: ProjectProfileId[];
  render: (context: PromptRenderContext, profile: ProjectProfile) => string | undefined;
}

export interface BuiltPrompt {
  system: string;
  user: string;
  profile: ProjectProfile;
}
