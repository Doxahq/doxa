import type {
  AgentProgressEvent,
  DocumentationStructure,
  ProjectAnalysis,
} from "../types";
import type {
  AnalysisState,
  DocsManifest,
  SourceChangeSet,
  SourceCheckpoint,
} from "../state/types";

export interface WorkspaceListOptions {
  prefix?: string;
  glob?: string;
  includeIgnored?: boolean;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface WorkspaceAdapter {
  readonly root?: string;
  readText(path: string): Promise<string | null>;
  listFiles(options?: WorkspaceListOptions): Promise<string[]>;
  grep(pattern: RegExp | string, options?: WorkspaceListOptions): Promise<GrepMatch[]>;
  hashFile(path: string): Promise<string | null>;
  hashFiles(paths: string[]): Promise<Record<string, string>>;
  getSourceChanges?(checkpoint?: SourceCheckpoint | null): Promise<SourceChangeSet>;
  createCheckpoint?(): Promise<SourceCheckpoint>;
}

export interface ArtifactEntry {
  path: string;
  contentHash?: string;
  size?: number;
  updatedAt?: string;
}

export interface ArtifactStore {
  writeText(path: string, content: string): Promise<void>;
  readText(path: string): Promise<string | null>;
  list(prefix?: string): Promise<ArtifactEntry[]>;
  delete(path: string): Promise<void>;
  prune?(activePaths: string[], prefix?: string): Promise<string[]>;
}

export interface StateStore {
  loadAnalysisState(): Promise<AnalysisState | null>;
  saveAnalysisState(state: AnalysisState): Promise<void>;
  loadStructure(): Promise<DocumentationStructure | null>;
  saveStructure(structure: DocumentationStructure): Promise<void>;
  loadDocsManifest(): Promise<DocsManifest | null>;
  saveDocsManifest(manifest: DocsManifest): Promise<void>;
  loadCheckpoint(): Promise<SourceCheckpoint | null>;
  saveCheckpoint(checkpoint: SourceCheckpoint): Promise<void>;
}

export type AgentEvent =
  | { type: "progress"; event: AgentProgressEvent }
  | { type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number; cost?: number }
  | { type: "warning"; message: string; details?: unknown }
  | { type: "error"; message: string; error?: unknown };

export interface EventSink {
  emit(event: AgentEvent): Promise<void> | void;
}

export interface MemoryStateStoreOptions {
  analysisState?: AnalysisState | null;
  structure?: DocumentationStructure | null;
  docsManifest?: DocsManifest | null;
  checkpoint?: SourceCheckpoint | null;
}

export interface AnalysisHandlerInput {
  workspace: WorkspaceAdapter;
  previousAnalysis: AnalysisState | null;
  sourceChanges: SourceChangeSet;
}

export interface StructureHandlerInput {
  analysis: ProjectAnalysis;
  answers: Record<string, unknown>;
  previousStructure: DocumentationStructure | null;
}
