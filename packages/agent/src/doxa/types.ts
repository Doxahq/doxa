import type {
  DocumentationStructure,
  GeneratedPageContent,
  GenerationResult,
  ProjectAnalysis,
  StructureSuggestionInput,
  WriterContext,
} from "../types";
import type {
  AnalysisHandlerInput,
  EventSink,
  StateStore,
  StructureHandlerInput,
  WorkspaceAdapter,
  ArtifactStore,
} from "../adapters/types";
import type { PageTarget, SourceChangeSet } from "../state/types";
import type { Provider } from "../core";

export interface PageWriterInput {
  target: PageTarget;
  workspace: WorkspaceAdapter;
  writerContext?: WriterContext;
}

export interface PageWriterResult {
  content: string;
  sourceFilesRead?: string[];
  sourceFilesDiscovered?: string[];
}

export interface DoxaAgentHandlers {
  analyzeProject?: (input: AnalysisHandlerInput) => Promise<{
    analysis: ProjectAnalysis;
    explorationContext: string;
  }>;
  suggestStructure?: (input: StructureHandlerInput) => Promise<DocumentationStructure>;
  writePage?: (input: PageWriterInput) => Promise<PageWriterResult>;
}

export interface DoxaAgentConfig {
  workspace: WorkspaceAdapter;
  state: StateStore;
  artifacts: ArtifactStore;
  events?: EventSink;
  provider?: Provider;
  handlers?: DoxaAgentHandlers;
}

export interface AnalyzeProjectOptions {
  sourceChanges?: SourceChangeSet;
  force?: boolean;
}

export interface SuggestStructureOptions extends Omit<StructureSuggestionInput, "analysis"> {
  analysis?: ProjectAnalysis;
  force?: boolean;
}

export interface GenerateDocsOptions {
  analysis?: ProjectAnalysis | null;
  structure?: DocumentationStructure;
  writerContext?: WriterContext;
  sourceChanges?: SourceChangeSet;
  force?: boolean;
  outputPrefix?: string;
}

export interface UpdateDocsOptions {
  answers?: Record<string, unknown>;
  sourceChanges?: SourceChangeSet;
  refreshStructure?: boolean;
  force?: boolean;
}

export interface DoxaAgent {
  analyzeProject(options?: AnalyzeProjectOptions): Promise<ProjectAnalysis>;
  suggestStructure(options: SuggestStructureOptions): Promise<DocumentationStructure>;
  generateDocs(options?: GenerateDocsOptions): Promise<GenerationResult>;
  updateDocs(options?: UpdateDocsOptions): Promise<GenerationResult>;
}

export interface MaterializedPage extends GeneratedPageContent {
  pageId: string;
}
