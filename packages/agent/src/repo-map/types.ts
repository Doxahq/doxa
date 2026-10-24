/**
 * Repo map types.
 * A repo map is a compact, code-derived outline of a repository: areas,
 * the most referenced files, and the symbols each file declares. The planner
 * reads it before it explores, so it opens fewer files.
 */

export type RepoMapLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "generic";

export type RepoSymbolKind =
  | "function"
  | "class"
  | "type"
  | "const"
  | "method"
  | "module"
  | "macro"
  | "route"
  | "reexport";

export interface RepoSymbol {
  name: string;
  kind: RepoSymbolKind;
  /** True when other modules can import the symbol. */
  exported: boolean;
  /** 1-based line of the declaration. */
  line: number;
}

/** A dependency as written in the source, before it is resolved to a file. */
export interface RepoImport {
  specifier: string;
  /** Names imported from the specifier, for `from pkg import name` in Python. */
  names?: string[];
  /** Rust `mod name;` declarations resolve relative to the declaring file. */
  kind?: "module-declaration";
}

export interface FileExtraction {
  symbols: RepoSymbol[];
  imports: RepoImport[];
  /** Identifiers used in code, outside comments and strings. */
  identifiers: Set<string>;
}

export interface SourceFileInput {
  path: string;
  language: RepoMapLanguage;
  content: string;
}

/**
 * Extracts symbols and imports from one file. The lexical extractor is the
 * default; a syntax-tree extractor can replace it behind this interface.
 * Bump `version` whenever the output for the same input can change, because
 * it is part of the cache key.
 */
export interface SymbolExtractor {
  readonly version: string;
  extract(file: SourceFileInput): FileExtraction;
}

export interface RepoMapFile {
  path: string;
  language: RepoMapLanguage;
  symbols: RepoSymbol[];
  /** Resolved project files this file depends on, sorted. */
  dependencies: string[];
  /** Test and fixture files rank other files but are not shown. */
  hidden: boolean;
}

export interface RepoMapArea {
  /** Directory of the area, relative to the project root ("." for root files). */
  path: string;
  /** Package name (or Go module path) from the area's manifest, when it has one. */
  packageName?: string;
  files: RankedRepoMapFile[];
  score: number;
}

export interface RankedRepoMapFile extends RepoMapFile {
  score: number;
}

export interface RepoMapStats {
  /** Files listed in the project, before filtering. */
  fileCount: number;
  /** Files the extractor parsed. */
  sourceFileCount: number;
  symbolCount: number;
  areaCount: number;
  /** Files that appear in the rendered text. */
  renderedFileCount: number;
  tokenEstimate: number;
}

/** The cached value. JSON-safe so any store (memory, disk, R2) can hold it. */
export interface RepoMapSnapshot {
  formatVersion: number;
  key: string;
  text: string;
  stats: RepoMapStats;
}

export type RepoMapTelemetry =
  | {
      status: "ready";
      cacheHit: boolean;
      durationMs: number;
      stats: RepoMapStats;
    }
  | {
      status: "skipped";
      reason: string;
      durationMs: number;
    };
