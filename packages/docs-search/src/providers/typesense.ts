import { z } from "zod";

import {
  searchLineSchema,
  type RuntimeSearchDocument,
  type RuntimeSearchResult,
} from "../contracts";
import { toSearchResult } from "../results";
import {
  SEARCH_PROVIDER_REQUEST_TIMEOUT_MS,
  SearchIndexMissingError,
  SearchProviderError,
  type SearchIndexFacts,
  type SearchIndexInput,
  type SearchIndexWriter,
  type SearchQuery,
  type SearchReader,
} from "./types";

const API_KEY_HEADER = "x-typesense-api-key";
const IMPORT_BATCH_DOCUMENTS = 250;
const MISSING_STATUS = 404;
const EXISTS_STATUS = 409;

/**
 * The search settings. They were tested against MiniSearch with the query set
 * of `docs/current/docs-search.md`: `min_len_2typo` and
 * `drop_tokens_threshold` fix `srach` and `depl cloudflare`.
 */
const SEARCH_SETTINGS = {
  query_by: "title,headings,keywords,content",
  query_by_weights: "5,3,2,1",
  include_fields: "id,slug,title,breadcrumb,icon,section,lines",
  highlight_fields: "title,headings,keywords,content",
  highlight_affix_num_tokens: 1,
  prefix: true,
  num_typos: 2,
  min_len_1typo: 4,
  min_len_2typo: 5,
  drop_tokens_threshold: 3,
} as const;

/** Only indexed fields use RAM. Stored fields stay on disk. */
const COLLECTION_FIELDS = [
  { name: "title", type: "string" },
  { name: "headings", type: "string[]" },
  { name: "keywords", type: "string[]" },
  { name: "content", type: "string" },
] as const;

export interface TypesenseConnection {
  /** The HTTPS origin of the cluster. */
  host: string;
  apiKey: string;
  fetch?: typeof fetch;
}

const searchAnswerSchema = z.object({
  results: z.array(
    z.object({
      code: z.number().optional(),
      error: z.string().optional(),
      hits: z
        .array(
          z.object({
            document: z.object({
              id: z.string(),
              slug: z.string(),
              title: z.string(),
              breadcrumb: z.array(z.string()).default([]),
              icon: z.string().optional(),
              section: z.string().optional(),
              lines: z.array(searchLineSchema).default([]),
            }),
            highlights: z
              .array(
                z.object({
                  matched_tokens: z.array(z.unknown()).default([]),
                }),
              )
              .default([]),
            text_match: z.number().default(0),
          }),
        )
        .default([]),
    }),
  ),
});

export function createTypesenseReader(
  connection: TypesenseConnection,
): SearchReader {
  const client = createClient(connection);
  return {
    async search(input: SearchQuery): Promise<RuntimeSearchResult[]> {
      // The query goes in a JSON body with fixed settings, so search text
      // cannot add a search parameter.
      const response = await client.request("/multi_search", {
        method: "POST",
        body: JSON.stringify({
          searches: [
            {
              ...SEARCH_SETTINGS,
              collection: input.indexKey,
              q: input.query,
              per_page: input.limit,
            },
          ],
        }),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!response.ok) throw failure("search", response.status);

      const answer = searchAnswerSchema.safeParse(await response.json());
      const result = answer.success ? answer.data.results[0] : undefined;
      if (!result) throw new SearchProviderError("Unexpected search answer.");
      if (result.code === MISSING_STATUS) {
        throw new SearchIndexMissingError(input.indexKey);
      }
      if (result.error) throw failure("search", result.code);

      return result.hits.map((hit) =>
        toSearchResult({
          stored: hit.document,
          query: input.query,
          matchedTerms: hit.highlights
            .flatMap((highlight) => highlight.matched_tokens.flat(2))
            .filter((token): token is string => typeof token === "string"),
          score: hit.text_match,
        }),
      );
    },
  };
}

export function createTypesenseWriter(
  connection: TypesenseConnection,
): SearchIndexWriter {
  const client = createClient(connection);

  const createCollection = async (
    indexKey: string,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    const response = await client.request("/collections", {
      method: "POST",
      body: JSON.stringify({ name: indexKey, fields: COLLECTION_FIELDS }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok && response.status !== EXISTS_STATUS) {
      throw failure("create index", response.status);
    }
  };

  const importBatch = async (
    indexKey: string,
    documents: readonly RuntimeSearchDocument[],
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    const response = await client.request(
      `/collections/${encodeURIComponent(indexKey)}/documents/import?action=upsert`,
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: documents
          .map((document) => JSON.stringify(toRecord(document)))
          .join("\n"),
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) throw failure("import", response.status);
    const lines = (await response.text())
      .split("\n")
      .filter((line) => line.trim());
    if (
      lines.length !== documents.length ||
      !lines.every(isAcceptedImportLine)
    ) {
      const accepted = lines.filter(isAcceptedImportLine).length;
      throw new SearchProviderError(
        `Import accepted ${accepted} of ${documents.length} documents.`,
      );
    }
  };

  return {
    async writeIndex(input: SearchIndexInput): Promise<SearchIndexFacts> {
      await createCollection(input.indexKey, input.signal);
      for (
        let start = 0;
        start < input.documents.length;
        start += IMPORT_BATCH_DOCUMENTS
      ) {
        await importBatch(
          input.indexKey,
          input.documents.slice(start, start + IMPORT_BATCH_DOCUMENTS),
          input.signal,
        );
      }
      return {
        documents: input.documents.length,
        indexedBytes: input.documents.reduce(
          (total, document) => total + indexedBytes(document),
          0,
        ),
      };
    },
    async removeIndex(indexKey, signal): Promise<void> {
      const response = await client.request(
        `/collections/${encodeURIComponent(indexKey)}`,
        { method: "DELETE", ...(signal ? { signal } : {}) },
      );
      if (!response.ok && response.status !== MISSING_STATUS) {
        throw failure("remove index", response.status);
      }
    },
    async hasIndex(indexKey, signal): Promise<boolean> {
      const response = await client.request(
        `/collections/${encodeURIComponent(indexKey)}`,
        { method: "GET", ...(signal ? { signal } : {}) },
      );
      if (response.status === MISSING_STATUS) return false;
      if (!response.ok) throw failure("read index", response.status);
      return true;
    },
  };
}

function createClient(connection: TypesenseConnection) {
  const origin = parseOrigin(connection.host);
  const send = connection.fetch ?? fetch;
  return {
    request(path: string, init: RequestInit): Promise<Response> {
      const headers = new Headers(init.headers);
      headers.set(API_KEY_HEADER, connection.apiKey);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      // A stalled provider must not hold the caller. A caller's shorter
      // deadline, for example the gateway's, still applies.
      const timeout = AbortSignal.timeout(SEARCH_PROVIDER_REQUEST_TIMEOUT_MS);
      const signal = init.signal
        ? AbortSignal.any([init.signal, timeout])
        : timeout;
      return send(`${origin}${path}`, { ...init, headers, signal });
    },
  };
}

/** The host is operator configuration. It still must be a plain origin. */
function parseOrigin(host: string): string {
  const url = new URL(host);
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new SearchProviderError("The Typesense host must use HTTPS.");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search) {
    throw new SearchProviderError("The Typesense host must be a plain origin.");
  }
  return url.origin;
}

/**
 * Typesense answers one JSON line for each document. Every line must say success,
 * and the count must match, so an empty or short answer also fails.
 */
function isAcceptedImportLine(line: string): boolean {
  try {
    return (JSON.parse(line) as { success?: unknown } | null)?.success === true;
  } catch {
    return false;
  }
}

function toRecord(document: RuntimeSearchDocument) {
  return {
    id: document.id,
    slug: document.slug,
    title: document.title,
    breadcrumb: document.breadcrumb,
    ...(document.icon ? { icon: document.icon } : {}),
    section: document.section,
    headings: document.headings,
    keywords: document.keywords,
    content: document.content,
    lines: document.lines,
  };
}

function indexedBytes(document: RuntimeSearchDocument): number {
  const encoder = new TextEncoder();
  const size = (text: string) => encoder.encode(text).length;
  return (
    size(document.title) +
    size(document.content) +
    document.headings.reduce((total, text) => total + size(text), 0) +
    document.keywords.reduce((total, text) => total + size(text), 0)
  );
}

function failure(step: string, status: number | undefined): SearchProviderError {
  return new SearchProviderError(
    `Typesense ${step} failed${status ? ` with status ${status}` : ""}.`,
    status,
  );
}
