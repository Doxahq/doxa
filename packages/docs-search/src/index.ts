import MiniSearch, { type SearchResult as MiniSearchResult } from "minisearch";
import { z } from "zod";

import {
  compiledSearchArtifactSchema,
  runtimeSearchArtifactSchema,
  runtimeSearchQuerySchema,
  searchLineSchema,
  type CompiledSearchArtifact,
  type RuntimeSearchArtifact,
  type RuntimeSearchDocument,
  type RuntimeSearchResult,
} from "./contracts";
import { SEARCH_FIELD_CONFIG } from "./engine-config";
import { toSearchResult } from "./results";

export * from "./contracts";
export { toSearchResult } from "./results";

interface IndexableSearchDocument extends RuntimeSearchDocument {
  headingsText: string;
  keywordsText: string;
}

const INDEX_CONFIG = {
  ...SEARCH_FIELD_CONFIG,
  storeFields: ["slug", "title", "breadcrumb", "icon", "section", "lines"],
};

export interface SearchEngine {
  readonly contentVersion: string;
  search(query: string, limit?: number): RuntimeSearchResult[];
}

export function compileSearchArtifact(
  artifact: RuntimeSearchArtifact,
): CompiledSearchArtifact {
  const parsed = runtimeSearchArtifactSchema.parse(artifact);
  return {
    schemaVersion: 1,
    contentVersion: parsed.contentVersion,
    serializedIndex: JSON.stringify(buildIndex(parsed.documents)),
  };
}

export function createSearchEngine(
  artifact: CompiledSearchArtifact | RuntimeSearchArtifact,
): SearchEngine {
  const compiled = compiledSearchArtifactSchema.safeParse(artifact);
  if (compiled.success) {
    return createEngine(
      compiled.data.contentVersion,
      MiniSearch.loadJSON<IndexableSearchDocument>(
        compiled.data.serializedIndex,
        INDEX_CONFIG,
      ),
    );
  }

  const source = runtimeSearchArtifactSchema.parse(artifact);
  return createEngine(source.contentVersion, buildIndex(source.documents));
}

function createEngine(
  contentVersion: string,
  index: MiniSearch<IndexableSearchDocument>,
): SearchEngine {
  return {
    contentVersion,
    search(query, limit = 8) {
      const input = runtimeSearchQuerySchema.parse({ query, limit });
      return toRuntimeSearchResults(
        index.search(input.query),
        input.query,
        input.limit,
      );
    },
  };
}

function buildIndex(
  documents: RuntimeSearchDocument[],
): MiniSearch<IndexableSearchDocument> {
  const index = new MiniSearch<IndexableSearchDocument>(INDEX_CONFIG);
  index.addAll(documents.map(toIndexableDocument));
  return index;
}

function toIndexableDocument(
  document: RuntimeSearchDocument,
): IndexableSearchDocument {
  return {
    ...document,
    headingsText: document.headings.join(" "),
    keywordsText: document.keywords.join(" "),
  };
}

function toRuntimeSearchResults(
  hits: MiniSearchResult[],
  query: string,
  limit: number,
): RuntimeSearchResult[] {
  return hits.slice(0, limit).map((hit) => {
    const stored = runtimeStoredResultSchema.parse(hit);
    return toSearchResult({
      stored,
      query,
      matchedTerms: hit.terms,
      score: hit.score,
    });
  });
}

const runtimeStoredResultSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  breadcrumb: z.array(z.string()).default([]),
  icon: z.string().optional(),
  section: z.string().optional(),
  lines: z.array(searchLineSchema).default([]),
});

const legacyRuntimeSearchArtifactSchema = z.object({
  documents: z.array(
    z.object({
      title: z.string(),
      href: z.string(),
      text: z.string(),
    }),
  ),
});

export function parseRuntimeSearchArtifact(
  raw: string,
): RuntimeSearchArtifact | null {
  try {
    const value: unknown = JSON.parse(raw);
    const current = runtimeSearchArtifactSchema.safeParse(value);
    if (current.success) return current.data;

    const legacy = legacyRuntimeSearchArtifactSchema.safeParse(value);
    if (!legacy.success) return null;

    return {
      schemaVersion: 1,
      contentVersion: `legacy-${hashText(raw)}`,
      documents: legacy.data.documents.map((document) => ({
        id: document.href,
        slug: document.href,
        title: document.title,
        description: "",
        breadcrumb: [],
        section: "default",
        headings: [],
        keywords: [],
        content: document.text,
        lines: document.text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((text) => ({ text })),
      })),
    };
  } catch {
    return null;
  }
}

function hashText(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
