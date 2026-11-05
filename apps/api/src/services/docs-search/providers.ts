import type { DocsSearchRemoteProvider } from "@doxahq/contracts/docs-search";
import {
  createTypesenseWriter,
  type SearchIndexWriter,
} from "@doxahq/docs-search/providers";

import type { Env } from "../../env";

export type DocsSearchWriters = Partial<
  Record<DocsSearchRemoteProvider, SearchIndexWriter>
>;

/** The writers this deployment has credentials for. */
export function createDocsSearchWriters(
  env: Pick<Env, "SEARCH_TYPESENSE_HOST" | "SEARCH_TYPESENSE_WRITE_KEY">,
): DocsSearchWriters {
  const writers: DocsSearchWriters = {};
  if (env.SEARCH_TYPESENSE_HOST && env.SEARCH_TYPESENSE_WRITE_KEY) {
    writers.typesense = createTypesenseWriter({
      host: env.SEARCH_TYPESENSE_HOST,
      apiKey: env.SEARCH_TYPESENSE_WRITE_KEY,
    });
  }
  return writers;
}
