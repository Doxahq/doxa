/**
 * Builds a repo map from a source tree: list, extract, resolve imports,
 * rank, group into areas, and render within the token budget.
 */

import { groupAreas } from "./areas";
import { DEFAULT_REPO_MAP_TOKEN_BUDGET, estimateTokens } from "./budget";
import { compareStrings } from "./collections";
import { lexicalSymbolExtractor } from "./extractors";
import { buildReferenceGraph, type GraphNodeInput } from "./graph";
import { detectLanguage } from "./languages";
import { isManifestPath, readPackageRoots, type ManifestInput } from "./packages";
import { isHiddenPath, isSkippedPath } from "./paths";
import { rankFiles } from "./rank";
import { renderRepoMap } from "./render";
import { createImportResolver } from "./resolve";
import type { RepoMapSourceEntry, RepoMapSourceTree } from "./source-tree";
import type {
  FileExtraction,
  RankedRepoMapFile,
  RepoMapLanguage,
  RepoMapStats,
  SymbolExtractor,
} from "./types";

export interface RepoMapLimits {
  /** More source files than this: no map; exploration runs as before. */
  maxSourceFiles: number;
  /** Larger files are skipped: they are almost always generated or bundled. */
  maxFileBytes: number;
  /** More source bytes than this in total: no map. */
  maxTotalBytes: number;
}

/**
 * A build costs about 0.4 ms per source file on a laptop (1.9k files in
 * 0.75 s, this monorepo), so these caps keep it to a few seconds. Larger
 * repositories fall back to plain exploration.
 */
export const DEFAULT_REPO_MAP_LIMITS: RepoMapLimits = {
  maxSourceFiles: 10_000,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

/** Files read at once. */
const READ_BATCH_SIZE = 64;

export class RepoMapLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoMapLimitError";
  }
}

export interface BuildRepoMapOptions {
  tokenBudget?: number;
  extractor?: SymbolExtractor;
  limits?: Partial<RepoMapLimits>;
}

export interface BuiltRepoMap {
  text: string;
  stats: RepoMapStats;
}

interface ParsedFile {
  path: string;
  language: RepoMapLanguage;
  extraction: FileExtraction;
}

export async function buildRepoMap(
  tree: RepoMapSourceTree,
  options: BuildRepoMapOptions = {},
  listed?: readonly RepoMapSourceEntry[],
): Promise<BuiltRepoMap> {
  const limits = { ...DEFAULT_REPO_MAP_LIMITS, ...options.limits };
  const extractor = options.extractor ?? lexicalSymbolExtractor;
  const entries = listed ?? await tree.list();

  const sourceEntries = entries.filter((entry) =>
    entry.size <= limits.maxFileBytes && !isSkippedPath(entry.path) && detectLanguage(entry.path) !== null,
  );
  assertWithinLimits(sourceEntries, limits);

  const manifests = await readManifests(tree, entries, limits.maxFileBytes);
  const parsed = await parseSources(tree, sourceEntries, extractor);
  const packages = readPackageRoots(manifests);
  const resolve = createImportResolver(parsed.map((file) => file.path), packages);

  const nodes: GraphNodeInput[] = [];
  const dependencies = new Map<string, string[]>();
  for (const file of parsed) {
    const targets = new Set(file.extraction.imports.flatMap((entry) => resolve(file.path, file.language, entry)));
    const sorted = [...targets].sort(compareStrings);
    dependencies.set(file.path, sorted);
    nodes.push({
      path: file.path,
      dependencies: sorted,
      exportedNames: file.extraction.symbols
        .filter((symbol) => symbol.exported && symbol.kind !== "route" && symbol.kind !== "reexport")
        .map((symbol) => symbol.name),
      identifiers: file.extraction.identifiers,
    });
  }
  const scores = rankFiles(buildReferenceGraph(nodes));

  const ranked: RankedRepoMapFile[] = parsed.map((file) => ({
    path: file.path,
    language: file.language,
    symbols: file.extraction.symbols,
    dependencies: dependencies.get(file.path) ?? [],
    hidden: isHiddenPath(file.path),
    score: scores.get(file.path) ?? 0,
  }));
  const areas = groupAreas(ranked, packages);
  const visible = ranked.filter((file) => !file.hidden);
  const symbolCount = visible.reduce((sum, file) => sum + file.symbols.length, 0);
  const rendered = renderRepoMap({
    areas,
    sourceFileCount: visible.length,
    symbolCount,
    tokenBudget: options.tokenBudget ?? DEFAULT_REPO_MAP_TOKEN_BUDGET,
  });

  return {
    text: rendered.text,
    stats: {
      fileCount: entries.length,
      sourceFileCount: parsed.length,
      symbolCount,
      areaCount: areas.filter((area) => area.files.some((file) => !file.hidden)).length,
      renderedFileCount: rendered.renderedFileCount,
      tokenEstimate: estimateTokens(rendered.text),
    },
  };
}

function assertWithinLimits(entries: readonly RepoMapSourceEntry[], limits: RepoMapLimits): void {
  if (entries.length > limits.maxSourceFiles) {
    throw new RepoMapLimitError(
      `${entries.length} source files exceed the repo map limit of ${limits.maxSourceFiles}.`,
    );
  }
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes > limits.maxTotalBytes) {
    throw new RepoMapLimitError(
      `${totalBytes} source bytes exceed the repo map limit of ${limits.maxTotalBytes}.`,
    );
  }
}

async function readManifests(
  tree: RepoMapSourceTree,
  entries: readonly RepoMapSourceEntry[],
  maxFileBytes: number,
): Promise<ManifestInput[]> {
  const manifestEntries = entries.filter((entry) =>
    entry.size <= maxFileBytes && isManifestPath(entry.path) && !isSkippedPath(entry.path) && !isHiddenPath(entry.path),
  );
  const manifests: ManifestInput[] = [];
  for (const entry of manifestEntries) {
    const content = await tree.readText(entry.path);
    if (content !== null) manifests.push({ path: entry.path, content });
  }
  return manifests;
}

async function parseSources(
  tree: RepoMapSourceTree,
  entries: readonly RepoMapSourceEntry[],
  extractor: SymbolExtractor,
): Promise<ParsedFile[]> {
  const parsed: ParsedFile[] = [];
  for (let start = 0; start < entries.length; start += READ_BATCH_SIZE) {
    const batch = entries.slice(start, start + READ_BATCH_SIZE);
    const contents = await Promise.all(batch.map((entry) => tree.readText(entry.path)));
    batch.forEach((entry, index) => {
      const content = contents[index];
      const language = detectLanguage(entry.path);
      if (content === null || language === null) return;
      parsed.push({
        path: entry.path,
        language,
        extraction: extractor.extract({ path: entry.path, language, content }),
      });
    });
  }
  return parsed;
}
