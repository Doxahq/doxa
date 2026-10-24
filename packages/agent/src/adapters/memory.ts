import type { DocumentationStructure } from "../types";
import type {
  AnalysisState,
  DocsManifest,
  SourceCheckpoint,
} from "../state/types";
import type {
  ArtifactEntry,
  ArtifactStore,
  MemoryStateStoreOptions,
  StateStore,
} from "./types";

export class MemoryStateStore implements StateStore {
  private analysisState: AnalysisState | null;
  private structure: DocumentationStructure | null;
  private docsManifest: DocsManifest | null;
  private checkpoint: SourceCheckpoint | null;

  constructor(options: MemoryStateStoreOptions = {}) {
    this.analysisState = options.analysisState ?? null;
    this.structure = options.structure ?? null;
    this.docsManifest = options.docsManifest ?? null;
    this.checkpoint = options.checkpoint ?? null;
  }

  async loadAnalysisState(): Promise<AnalysisState | null> {
    return clone(this.analysisState);
  }

  async saveAnalysisState(state: AnalysisState): Promise<void> {
    this.analysisState = clone(state);
  }

  async loadStructure(): Promise<DocumentationStructure | null> {
    return clone(this.structure);
  }

  async saveStructure(structure: DocumentationStructure): Promise<void> {
    this.structure = clone(structure);
  }

  async loadDocsManifest(): Promise<DocsManifest | null> {
    return clone(this.docsManifest);
  }

  async saveDocsManifest(manifest: DocsManifest): Promise<void> {
    this.docsManifest = clone(manifest);
  }

  async loadCheckpoint(): Promise<SourceCheckpoint | null> {
    return clone(this.checkpoint);
  }

  async saveCheckpoint(checkpoint: SourceCheckpoint): Promise<void> {
    this.checkpoint = clone(checkpoint);
  }
}

export class MemoryArtifactStore implements ArtifactStore {
  private readonly files = new Map<string, { content: string; updatedAt: string }>();

  constructor(initialFiles: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initialFiles)) {
      this.files.set(normalizePath(path), { content, updatedAt: new Date().toISOString() });
    }
  }

  async writeText(path: string, content: string): Promise<void> {
    this.files.set(normalizePath(path), { content, updatedAt: new Date().toISOString() });
  }

  async readText(path: string): Promise<string | null> {
    return this.files.get(normalizePath(path))?.content ?? null;
  }

  async list(prefix = ""): Promise<ArtifactEntry[]> {
    const normalizedPrefix = normalizePath(prefix);
    return [...this.files.entries()]
      .filter(([path]) => !normalizedPrefix || path.startsWith(normalizedPrefix))
      .map(([path, entry]) => ({
        path,
        size: entry.content.length,
        updatedAt: entry.updatedAt,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async delete(path: string): Promise<void> {
    this.files.delete(normalizePath(path));
  }

  async prune(activePaths: string[], prefix = ""): Promise<string[]> {
    const active = new Set(activePaths.map(normalizePath));
    const normalizedPrefix = normalizePath(prefix);
    const deleted: string[] = [];

    for (const path of this.files.keys()) {
      if (normalizedPrefix && !path.startsWith(normalizedPrefix)) continue;
      if (active.has(path)) continue;
      this.files.delete(path);
      deleted.push(path);
    }

    return deleted.sort();
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function clone<T>(value: T): T {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
