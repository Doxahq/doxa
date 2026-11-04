import type { DoxaDocsRuntimeSource } from "@/src/runtime/runtime-source";
import {
  compiledSearchArtifactSchema,
  createSearchEngine,
  parseRuntimeSearchArtifact,
  type RuntimeSearchResult,
  type SearchEngine,
} from "@doxahq/docs-search";

import { utf8ByteLength } from "@/src/lib/utf8";

/**
 * One renderer isolate serves many sites (M46), so the engines of every site
 * share this budget. It counts the serialized index, the size the isolate
 * read; an engine in memory is of the same order.
 */
export const DEFAULT_SEARCH_CACHE_BYTES = 20 * 1024 * 1024;

/**
 * Largest index one site may keep in the shared cache, so one site cannot
 * evict every other site's engine. A bigger index is built per request.
 */
export const DEFAULT_SEARCH_ENTRY_BYTES = 5 * 1024 * 1024;

/**
 * Largest serialized index the isolate parses at all. Above it a search
 * answers no results: building it on every request in the shared isolate
 * costs every other site on it.
 */
export const DEFAULT_SEARCH_INDEX_READ_BYTES = 8 * 1024 * 1024;

/** Published versions remembered as too large, oldest dropped first. */
const MAX_TOO_LARGE_MARKERS = 256;

export interface ServerSearchOptions {
  maxCacheBytes?: number;
  maxEntryBytes?: number;
  maxIndexBytes?: number;
}

interface CachedEngine {
  engine: SearchEngine;
  bytes: number;
}

/** Search engines by site scope and content version, within a byte budget. */
export interface SearchEngineCache {
  get(key: string): SearchEngine | undefined;
  /** Keeps the engine unless its index alone is above the budget. */
  remember(key: string, engine: SearchEngine, bytes: number): void;
  readonly totalBytes: number;
  readonly size: number;
}

export function createSearchEngineCache(
  maxBytes: number,
  maxEntryBytes: number = maxBytes
): SearchEngineCache {
  const entries = new Map<string, CachedEngine>();
  let totalBytes = 0;

  const evict = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    totalBytes -= entry.bytes;
  };

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      // Map keeps insertion order: move the entry to the newest end.
      entries.delete(key);
      entries.set(key, entry);
      return entry.engine;
    },
    remember(key, engine, bytes) {
      evict(key);
      if (bytes > maxBytes || bytes > maxEntryBytes) return;
      entries.set(key, { engine, bytes });
      totalBytes += bytes;
      while (totalBytes > maxBytes) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        evict(oldest.value);
      }
    },
    get totalBytes() {
      return totalBytes;
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * The cache key of a site's index. A source without a `cacheScope` gets
 * none: its engine is built for this request only.
 */
export function searchEngineCacheKey(
  source: Pick<DoxaDocsRuntimeSource, "cacheScope">,
  contentVersion: string
): string | null {
  return source.cacheScope ? `${source.cacheScope}:${contentVersion}` : null;
}

/**
 * The cache key of a source whose scope names one published version
 * (`site:{siteId}:{versionId}`). That version never changes, so its engine
 * can be found before the index is read. Host scopes can move to a newer
 * version, so they get no such key.
 */
export function publishedVersionSearchKey(
  source: Pick<DoxaDocsRuntimeSource, "cacheScope">
): string | null {
  return source.cacheScope?.startsWith("site:")
    ? `${source.cacheScope}:published`
    : null;
}

/**
 * Published versions whose index is above the read limit. A version never
 * changes, so later searches skip reading the index at all.
 */
function createTooLargeMarkers(maxEntries: number) {
  const keys = new Set<string>();
  return {
    has: (key: string) => keys.has(key),
    add(key: string) {
      keys.delete(key);
      keys.add(key);
      while (keys.size > maxEntries) {
        const oldest = keys.values().next();
        if (oldest.done) break;
        keys.delete(oldest.value);
      }
    },
    get size() {
      return keys.size;
    },
  };
}

function logSearchIndexTooLarge(input: {
  bytes: number;
  limitBytes: number;
  cacheScope: string | undefined;
}): void {
  console.warn(
    JSON.stringify({
      event: "docs_search_index_too_large",
      bytes: input.bytes,
      limitBytes: input.limitBytes,
      ...(input.cacheScope ? { scope: input.cacheScope } : {}),
    })
  );
}

export function createServerSearch({
  maxCacheBytes = DEFAULT_SEARCH_CACHE_BYTES,
  maxEntryBytes = DEFAULT_SEARCH_ENTRY_BYTES,
  maxIndexBytes = DEFAULT_SEARCH_INDEX_READ_BYTES,
}: ServerSearchOptions = {}) {
  const cache = createSearchEngineCache(maxCacheBytes, maxEntryBytes);
  const tooLarge = createTooLargeMarkers(MAX_TOO_LARGE_MARKERS);

  /** True (and remembered for a published version) when above the limit. */
  const exceedsReadLimit = (
    source: DoxaDocsRuntimeSource,
    raw: string,
    publishedKey: string | null
  ): boolean => {
    const bytes = utf8ByteLength(raw);
    if (bytes <= maxIndexBytes) return false;
    if (publishedKey) tooLarge.add(publishedKey);
    logSearchIndexTooLarge({
      bytes,
      limitBytes: maxIndexBytes,
      cacheScope: source.cacheScope,
    });
    return true;
  };

  const engineFor = <T extends { contentVersion: string }>(
    source: DoxaDocsRuntimeSource,
    artifact: T,
    serializedBytes: number,
    build: (artifact: T) => SearchEngine
  ): SearchEngine => {
    const key =
      publishedVersionSearchKey(source) ??
      searchEngineCacheKey(source, artifact.contentVersion);
    const cached = key ? cache.get(key) : undefined;
    if (cached) return cached;
    const engine = build(artifact);
    if (key) cache.remember(key, engine, serializedBytes);
    return engine;
  };

  async function search(
    source: DoxaDocsRuntimeSource,
    query: string,
    limit: number
  ): Promise<RuntimeSearchResult[]> {
    // A cached published version answers without reading or parsing its
    // index: every search would otherwise cost the full index in the shared
    // renderer isolate.
    const publishedKey = publishedVersionSearchKey(source);
    if (publishedKey && tooLarge.has(publishedKey)) return [];
    const known = publishedKey ? cache.get(publishedKey) : undefined;
    if (known) return known.search(query, limit);

    const rawCompiled = source.getCompiledSearchIndex
      ? await source.getCompiledSearchIndex()
      : null;
    if (rawCompiled && exceedsReadLimit(source, rawCompiled, publishedKey)) {
      return [];
    }
    const compiled = parseJson(rawCompiled, compiledSearchArtifactSchema);
    if (rawCompiled && compiled) {
      return engineFor(
        source,
        compiled,
        utf8ByteLength(rawCompiled),
        createSearchEngine
      ).search(query, limit);
    }

    const rawSourceArtifact = await source.getSearchIndex();
    if (
      rawSourceArtifact &&
      exceedsReadLimit(source, rawSourceArtifact, publishedKey)
    ) {
      return [];
    }
    const sourceArtifact = rawSourceArtifact
      ? parseRuntimeSearchArtifact(rawSourceArtifact)
      : null;
    if (!rawSourceArtifact || !sourceArtifact) return [];

    return engineFor(
      source,
      sourceArtifact,
      utf8ByteLength(rawSourceArtifact),
      createSearchEngine
    ).search(query, limit);
  }

  return Object.assign(search, { cache, tooLarge });
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

export const searchRuntimeDocs = createServerSearch();
