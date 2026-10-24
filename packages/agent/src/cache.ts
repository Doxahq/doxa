import type {
  CachedPageEntry,
  SourceChangeSet,
} from "./state/types";

export type { CachedPageEntry, SourceChangeSet };

export interface AnalysisCacheCheckResult extends SourceChangeSet {
  needsReanalysis: boolean;
  cachedAnalysis: Record<string, unknown> | null;
  cachedExplorationContext: string | null;
  currentCommitHash: string;
}

export interface DocsCacheCheckResult {
  needsRegeneration: boolean;
  pagesToRegenerate: string[];
  pagesFromCache: string[];
  reasons: Record<string, string>;
}

export interface AgentCacheManager {
  checkAnalysis(sourceChanges?: SourceChangeSet): Promise<AnalysisCacheCheckResult>;
  saveAnalysis(analysis: Record<string, unknown>, explorationContext: string): Promise<void>;
  checkDocs(
    structureHash: string,
    analysisHash: string,
    allPageIds: string[],
    pageInputHashes: Record<string, string>,
    changedFiles: string[],
    addedFiles: string[],
    deletedFiles: string[],
  ): Promise<DocsCacheCheckResult>;
  saveDocs(
    pages: CachedPageEntry[],
    structureHash: string,
    analysisHash: string,
  ): Promise<void>;
  updateDocPages(
    updatedPages: CachedPageEntry[],
    structureHash: string,
    analysisHash: string,
    activePageIds?: string[],
  ): Promise<void>;
}
