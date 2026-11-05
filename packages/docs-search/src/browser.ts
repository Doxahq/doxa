import MiniSearch, { type SearchResult as MiniSearchResult } from "minisearch";

import type { RuntimeSearchResult, SearchIndexLine } from "./contracts";
import { SEARCH_FIELD_CONFIG } from "./engine-config";
import { toSearchResult } from "./results";

/**
 * The search engine in a docs page. This module loads no schema library, so
 * the search chunk stays small on a phone.
 */
export interface BrowserSearchEngine {
  search(query: string, limit?: number): RuntimeSearchResult[];
  /** Adds snippet text after the index loaded. Search works without it. */
  addSnippets(snippets: SnippetsById): void;
}

const BROWSER_STORE_FIELDS = [
  "slug",
  "title",
  "breadcrumb",
  "icon",
  "section",
  "description",
];

export type SnippetsById = Readonly<Record<string, readonly SearchIndexLine[]>>;

/** Yields to the page while it loads, so a large index does not freeze typing. */
export async function loadBrowserSearchEngine(
  serializedIndex: string,
): Promise<BrowserSearchEngine> {
  const index = await MiniSearch.loadJSONAsync(serializedIndex, {
    ...SEARCH_FIELD_CONFIG,
    storeFields: BROWSER_STORE_FIELDS,
  });
  return createEngine(index);
}

/** Reads the snippets file. Any other shape counts as no snippets. */
export function parseSnippets(text: string): SnippetsById | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as SnippetsById)
      : null;
  } catch {
    return null;
  }
}

function createEngine(index: MiniSearch): BrowserSearchEngine {
  let snippets: SnippetsById = {};
  return {
    addSnippets(next) {
      snippets = next;
    },
    search(query, limit = 8) {
      return index
        .search(query)
        .slice(0, limit)
        .map((hit) => toResult(hit, query, snippets));
    },
  };
}

function toResult(
  hit: MiniSearchResult,
  query: string,
  snippets: SnippetsById,
): RuntimeSearchResult {
  const id = String(hit.id);
  const lines = snippets[id];
  const description = readString(hit.description);
  return toSearchResult({
    stored: {
      id,
      slug: readString(hit.slug),
      title: readString(hit.title),
      breadcrumb: Array.isArray(hit.breadcrumb)
        ? hit.breadcrumb.filter((part) => typeof part === "string")
        : [],
      ...(typeof hit.icon === "string" ? { icon: hit.icon } : {}),
      ...(typeof hit.section === "string" ? { section: hit.section } : {}),
      lines: Array.isArray(lines)
        ? [...lines]
        : description
          ? [{ text: description }]
          : [],
    },
    query,
    matchedTerms: hit.terms,
    score: hit.score,
  });
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
