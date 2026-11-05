import type { RuntimeSearchDocument, RuntimeSearchResult } from "../contracts";

/**
 * What a remote search provider must do. The gateway and the indexer use only
 * this interface, so a new provider needs one adapter and no pipeline change.
 * These modules run on the server and hold no browser code.
 */
export interface SearchQuery {
  /** Comes only from the resolved site and version. Never from a visitor. */
  indexKey: string;
  query: string;
  limit: number;
  signal?: AbortSignal;
}

export interface SearchReader {
  search(input: SearchQuery): Promise<RuntimeSearchResult[]>;
}

export interface SearchIndexInput {
  indexKey: string;
  documents: readonly RuntimeSearchDocument[];
  signal?: AbortSignal;
}

export interface SearchIndexFacts {
  documents: number;
  /** Bytes of indexed text: the base of the cost estimate. */
  indexedBytes: number;
}

export interface SearchIndexWriter {
  /** Safe to repeat: a retry ends with the same index. */
  writeIndex(input: SearchIndexInput): Promise<SearchIndexFacts>;
  /** Safe to repeat: a missing index counts as removed. */
  removeIndex(indexKey: string, signal?: AbortSignal): Promise<void>;
  /** Throws if the provider cannot answer, so an outage never looks like loss. */
  hasIndex(indexKey: string, signal?: AbortSignal): Promise<boolean>;
}

/**
 * No single provider request takes longer than this. The API's rules for
 * writers and deletes depend on it (`services/docs-search/limits.ts`).
 */
export const SEARCH_PROVIDER_REQUEST_TIMEOUT_MS = 30_000;

/** The published version has no index yet, for example during a publish. */
export class SearchIndexMissingError extends Error {
  constructor(indexKey: string) {
    super(`Search index ${indexKey} does not exist.`);
    this.name = "SearchIndexMissingError";
  }
}

/** The provider failed. The message holds no query text and no key. */
export class SearchProviderError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "SearchProviderError";
    this.status = status;
  }
}
