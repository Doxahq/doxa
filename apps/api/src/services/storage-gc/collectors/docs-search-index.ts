import {
  DOCS_SEARCH_INDEX_TARGET,
  docsSearchIndexResourceSchema,
  type DocsSearchIndexResource,
  type StorageCollector,
  type StorageGcCollection,
  type StorageGcInspection,
} from "@doxahq/contracts/storage-gc";

import { DOCS_SEARCH_RECHECK_SECONDS } from "../../docs-search/limits";
import type { DocsSearchWriters } from "../../docs-search/providers";

export interface DocsSearchIndexGcStore {
  isIndexInUse(resource: DocsSearchIndexResource): Promise<boolean>;
}

/**
 * Deletes one remote index. The resource names it, and the schema checks that
 * the index belongs to the site, so an entry cannot reach another collection.
 *
 * An index name is never used twice, so no later build can depend on this
 * index. A rollback builds a new index. The inspect step is a last safety check:
 * an index that something still uses stays, and it is checked again.
 */
export function createDocsSearchIndexCollector(input: {
  indexes: DocsSearchIndexGcStore;
  writers: DocsSearchWriters;
}): StorageCollector<DocsSearchIndexResource> {
  return {
    target: DOCS_SEARCH_INDEX_TARGET,
    parse(resource: unknown): DocsSearchIndexResource {
      return docsSearchIndexResourceSchema.parse(resource);
    },
    async inspect(
      resource: DocsSearchIndexResource,
    ): Promise<StorageGcInspection> {
      return (await input.indexes.isIndexInUse(resource))
        ? {
            status: "retain",
            reason: "index_in_use",
            recheckAfterSeconds: DOCS_SEARCH_RECHECK_SECONDS,
          }
        : { status: "collect" };
    },
    async collect(
      resource: DocsSearchIndexResource,
    ): Promise<StorageGcCollection> {
      const writer = input.writers[resource.provider];
      if (!writer) throw new Error("Search provider is not provisioned.");
      await writer.removeIndex(resource.indexKey);
      return { deletedObjects: 1, status: "complete" };
    },
  };
}
