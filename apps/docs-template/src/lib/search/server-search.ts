import type { DoxaDocsRuntimeSource } from "@/src/runtime/runtime-source";
import {
  compiledSearchArtifactSchema,
  createSearchEngine,
  parseRuntimeSearchArtifact,
  type RuntimeSearchResult,
  type SearchEngine,
} from "@doxahq/docs-search";

const DEFAULT_CACHE_SIZE = 50;

export function createServerSearch(maxCacheEntries = DEFAULT_CACHE_SIZE) {
  const engines = new Map<string, SearchEngine>();

  return async function search(
    source: DoxaDocsRuntimeSource,
    query: string,
    limit: number
  ): Promise<RuntimeSearchResult[]> {
    const compiled = source.getCompiledSearchIndex
      ? parseJson(
          await source.getCompiledSearchIndex(),
          compiledSearchArtifactSchema
        )
      : null;
    if (compiled) {
      const engine =
        engines.get(compiled.contentVersion) ?? createSearchEngine(compiled);
      rememberEngine(engines, engine, maxCacheEntries);
      return engine.search(query, limit);
    }

    const rawSourceArtifact = await source.getSearchIndex();
    const sourceArtifact = rawSourceArtifact
      ? parseRuntimeSearchArtifact(rawSourceArtifact)
      : null;
    if (!sourceArtifact) return [];

    const engine =
      engines.get(sourceArtifact.contentVersion) ??
      createSearchEngine(sourceArtifact);
    rememberEngine(engines, engine, maxCacheEntries);
    return engine.search(query, limit);
  };
}

function parseJson<T>(
  raw: string | null,
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  }
): T | null {
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    const result = schema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function rememberEngine(
  engines: Map<string, SearchEngine>,
  engine: SearchEngine,
  maxEntries: number
): void {
  engines.delete(engine.contentVersion);
  engines.set(engine.contentVersion, engine);

  while (engines.size > maxEntries) {
    const oldestKey = engines.keys().next().value;
    if (oldestKey === undefined) return;
    engines.delete(oldestKey);
  }
}

export const searchRuntimeDocs = createServerSearch();
