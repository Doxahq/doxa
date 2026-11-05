import {
  docsSearchIndexKeySchema,
  docsSearchRemoteProviderSchema,
  type DocsSearchRemoteProvider,
} from "@doxahq/contracts/docs-search";

/**
 * The search fields of a resolution. A site with browser search adds none, so
 * its resolution keeps the shape it always had.
 */
export function readDocsSearchTarget(site: {
  searchProvider: string;
  searchIndexKey: string | null;
}): { searchProvider?: DocsSearchRemoteProvider; searchIndexKey?: string } {
  const provider = docsSearchRemoteProviderSchema.safeParse(site.searchProvider);
  const indexKey = docsSearchIndexKeySchema.safeParse(site.searchIndexKey);
  return provider.success && indexKey.success
    ? { searchProvider: provider.data, searchIndexKey: indexKey.data }
    : {};
}
