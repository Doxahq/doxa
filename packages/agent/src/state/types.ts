import type {
  DocumentationStructure,
  PageDependencyState,
  PageReferenceMetadata,
  ProjectAnalysis,
  SourceEvidence,
} from "../types";
export type { PageDependencyState } from "../types";

export interface SourceChangeSet {
  changedFiles: string[];
  addedFiles: string[];
  deletedFiles: string[];
}

export interface RevisionSourceChange {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
}

export interface SourceCheckpoint {
  generatedAt: string;
  headCommitHash: string | null;
  defaultBranch: string | null;
  defaultBranchCommitHash: string | null;
  dirtyFileHashes: Record<string, string>;
  deletedFiles: string[];
}

export interface AnalysisState {
  analysis: ProjectAnalysis;
  explorationContext: string;
  sourceCheckpoint: SourceCheckpoint | null;
  updatedAt: string;
}

export interface PageTarget {
  pageId: string;
  title: string;
  sectionTitle: string;
  outputPath: string;
  description: string;
  sourceEvidence: SourceEvidence[];
  parentPageId?: string;
  collectionId?: string;
  collectionItemId?: string;
  canonicalRoute?: string;
  reference?: PageReferenceMetadata;
}

export interface CachedPageEntry {
  pageId: string;
  outputPath: string;
  title: string;
  sectionTitle: string;
  dependencies: PageDependencyState;
  contentHash: string;
  pageInputHash: string;
  generatedAt: string;
}

export interface DocsManifest {
  pages: CachedPageEntry[];
  structureHash: string;
  analysisHash: string;
  generatedAt: string;
}

export interface DocsGenerationPlan {
  needsGeneration: boolean;
  pagesToGenerate: string[];
  pagesFromCache: string[];
  reasons: Record<string, string>;
}

export interface RevisionAwareGenerationPlan {
  analysisMode: "reuse" | "incremental" | "full";
  /**
   * `reuse` keeps the published structure, `patch` keeps it and rebuilds the
   * reference sections from analysis, and `regenerate` plans it again.
   */
  structureMode: "reuse" | "patch" | "regenerate";
  regeneratePageIds: string[];
  reusePageIds: string[];
  removedPageIds: string[];
  modelCallsRequired: boolean;
  reasons: string[];
  causes?: RegenerationCauses;
  /** Set when every page is rewritten because the project instructions changed: existing pages are edited, not written again. */
  editReason?: "instructions_changed";
  /** Regenerated pages written only to follow the current instructions; see `catchUpInstructionPages`. */
  catchUpPageIds?: string[];
}

export interface RegenerationCauses {
  newPages: number;
  inputChanged: number;
  dependencyChanged: number;
  /** Pages written again only because the project instructions changed. */
  instructionsChanged?: number;
}

export interface AgentRunState {
  analysisState: AnalysisState | null;
  structure: DocumentationStructure | null;
  docsManifest: DocsManifest | null;
  checkpoint: SourceCheckpoint | null;
}
