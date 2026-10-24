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
  type SearchIndexLine,
} from "./contracts";

export * from "./contracts";

interface IndexableSearchDocument extends RuntimeSearchDocument {
  headingsText: string;
  keywordsText: string;
}

const INDEX_CONFIG = {
  idField: "id",
  fields: ["title", "headingsText", "keywordsText", "content"],
  storeFields: ["slug", "title", "breadcrumb", "icon", "section", "lines"],
  searchOptions: {
    prefix: true,
    fuzzy: 0.2,
    combineWith: "AND" as const,
    boost: {
      title: 5,
      headingsText: 3,
      keywordsText: 2,
      content: 1,
    },
  },
};

const MAX_SNIPPET_LENGTH = 180;
const SNIPPET_CONTEXT_RADIUS = 70;

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
  const queryTerms = extractTerms(query);

  return hits.slice(0, limit).map((hit) => {
    const stored = runtimeStoredResultSchema.parse(hit);
    const terms = [
      ...new Set([
        ...queryTerms,
        ...hit.terms.map((term) => term.toLowerCase()),
      ]),
    ];
    const snippet = pickSnippet(stored.lines, terms);

    return {
      id: stored.id,
      slug: stored.slug,
      title: stored.title,
      breadcrumb: stored.breadcrumb,
      ...(stored.icon ? { icon: stored.icon } : {}),
      ...(stored.section ? { section: stored.section } : {}),
      snippetLine: snippet.text,
      ...(snippet.anchor ? { snippetAnchor: snippet.anchor } : {}),
      score: hit.score,
      terms,
    };
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

function extractTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function pickSnippet(
  lines: SearchIndexLine[],
  terms: string[],
): { text: string; anchor?: string } {
  const firstLine = lines.find((line) => line.text.trim().length > 0);
  if (!firstLine) return { text: "" };

  let bestLine = firstLine;
  let bestScore = 0;
  let bestMatchIndex = 0;

  for (const line of lines) {
    const candidate = scoreLine(line.text, terms);
    if (candidate.score <= bestScore) continue;
    bestLine = line;
    bestScore = candidate.score;
    bestMatchIndex = candidate.firstMatchIndex;
  }

  return {
    text: truncateAround(bestLine.text, bestMatchIndex),
    ...(bestLine.anchor ? { anchor: bestLine.anchor } : {}),
  };
}

function scoreLine(
  text: string,
  terms: string[],
): { score: number; firstMatchIndex: number } {
  const lower = text.toLowerCase();
  const seen = new Set<string>();
  let score = 0;
  let firstMatchIndex = 0;
  let hasMatch = false;

  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index < 0) continue;
    if (!hasMatch || index < firstMatchIndex) firstMatchIndex = index;
    hasMatch = true;
    if (!seen.has(term)) {
      score += 10;
      seen.add(term);
    }
    if (index < 40) score += 2;
  }

  return { score, firstMatchIndex };
}

function truncateAround(text: string, anchorIndex: number): string {
  if (text.length <= MAX_SNIPPET_LENGTH) return text;
  const start = Math.max(0, anchorIndex - SNIPPET_CONTEXT_RADIUS);
  const end = Math.min(text.length, start + MAX_SNIPPET_LENGTH);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${
    end < text.length ? "…" : ""
  }`;
}
