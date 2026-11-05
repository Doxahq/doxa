import {
  runtimeSearchResponseSchema,
  type RuntimeSearchResult,
} from "@doxahq/docs-search/contracts";
import type { DocsSearchClientConfig } from "@doxahq/contracts/docs-search";

import {
  loadBrowserEngine,
  prefersLessData,
  readSearchConfig,
  readyBrowserEngine,
} from "./session";

export type SearchResult = RuntimeSearchResult;

const SERVER_SEARCH_PATH = "/api/search";

/**
 * Prepares search without blocking the page. `visitorAsked` means the visitor
 * moved to the search box, so it also loads on a slow connection.
 */
export async function preloadSearch(
  options: { visitorAsked?: boolean } = {},
): Promise<void> {
  const config = await readSearchConfig();
  if (config.mode === "gateway") {
    addPreconnect(config.endpoint);
    return;
  }
  if (config.mode === "browser" && (options.visitorAsked || !prefersLessData())) {
    await loadBrowserEngine(config);
  }
}

/** True when a search answers with no network call, so it needs no debounce. */
export async function isSearchInstant(): Promise<boolean> {
  const config = await readSearchConfig();
  return config.mode === "browser" && readyBrowserEngine(config) !== null;
}

/**
 * Searches with the site's backend. If that backend cannot answer, for example
 * while the browser index downloads or when the gateway fails, the renderer's
 * search answers, so a visitor never sees a false "No results".
 */
export async function searchDocs(
  query: string,
  limit = 8,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  const config = await readSearchConfig();
  const answer = await searchWithConfig(config, trimmed, limit, signal);
  return answer ?? (await requestServerSearch(trimmed, limit, signal));
}

async function searchWithConfig(
  config: DocsSearchClientConfig,
  query: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<SearchResult[] | null> {
  if (config.mode === "browser") {
    void loadBrowserEngine(config);
    return readyBrowserEngine(config)?.search(query, limit) ?? null;
  }
  if (config.mode === "gateway") {
    return requestGateway(config.endpoint, query, limit, signal);
  }
  return null;
}

/** Null asks for the fallback. An aborted search needs none, so it answers []. */
async function requestGateway(
  endpoint: string,
  query: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<SearchResult[] | null> {
  try {
    // A plain GET with no custom header needs no CORS preflight. The page's
    // origin selects the site, so the request names none.
    const response = await fetch(`${endpoint}?${searchParams(query, limit)}`, {
      credentials: "omit",
      signal,
    });
    if (!response.ok) return null;
    const parsed = runtimeSearchResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.results : null;
  } catch (error) {
    return isAbort(error) ? [] : null;
  }
}

async function requestServerSearch(
  query: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<SearchResult[]> {
  try {
    const response = await fetch(
      `${SERVER_SEARCH_PATH}?${searchParams(query, limit)}`,
      {
        headers: { accept: "application/json" },
        signal,
      },
    );
    if (!response.ok) return [];
    const parsed = runtimeSearchResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.results : [];
  } catch (error) {
    if (!isAbort(error)) console.warn("[search] request failed", error);
    return [];
  }
}

function searchParams(query: string, limit: number): URLSearchParams {
  return new URLSearchParams({ q: query, limit: String(limit) });
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function addPreconnect(endpoint: string): void {
  if (typeof document === "undefined") return;
  const { origin } = new URL(endpoint);
  if (document.querySelector(`link[rel="preconnect"][href="${origin}"]`)) return;
  const link = document.createElement("link");
  link.rel = "preconnect";
  link.href = origin;
  link.crossOrigin = "anonymous";
  document.head.appendChild(link);
}
