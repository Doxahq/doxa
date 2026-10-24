import {
  DOCS_DELETED_SITE_TARGET,
  STORAGE_GC_LIMITS,
  docsDeletedSiteResourceSchema,
  type DocsDeletedSiteResource,
  type StorageCollector,
  type StorageGcCollection,
} from "@doxahq/contracts/storage-gc";
import { siteBlobPrefix } from "@doxahq/docs-engine";

import type { DocsObjectStore } from "../../docs-content/store";

export interface DocsDeletedSiteStore {
  siteExists(siteId: string): Promise<boolean>;
}

/** Called after every object of the site outside its blobs is gone. */
export type OnDeletedSiteCollected = (
  resource: DocsDeletedSiteResource,
) => Promise<unknown>;

/**
 * Deletes the stored objects of a deleted site: version folders, generation
 * state, site assets, and any other key under `sites/<siteId>/`.
 *
 * Blobs stay. When the folders are gone, no tree marks a blob, so the
 * `docs_site_blobs` sweep deletes them with its own in-flight rule.
 */
export function createDocsDeletedSiteCollector(input: {
  sites: DocsDeletedSiteStore;
  objects: Pick<DocsObjectStore, "listKeys" | "removeMany">;
  onCollected?: OnDeletedSiteCollected;
}): StorageCollector<DocsDeletedSiteResource> {
  return {
    target: DOCS_DELETED_SITE_TARGET,
    parse: (resource) => docsDeletedSiteResourceSchema.parse(resource),
    async inspect(resource) {
      return (await input.sites.siteExists(resource.siteId))
        ? { status: "retain", reason: "site_exists" }
        : { status: "collect" };
    },
    collect: (resource) =>
      collectDeletedSite(input.objects, resource, input.onCollected),
  };
}

async function collectDeletedSite(
  objects: Pick<DocsObjectStore, "listKeys" | "removeMany">,
  resource: DocsDeletedSiteResource,
  onCollected: OnDeletedSiteCollected | undefined,
): Promise<StorageGcCollection> {
  const blobPrefix = siteBlobPrefix(resource.siteId);
  const keys = (await objects.listKeys(`sites/${resource.siteId}/`)).filter(
    (key) => !key.startsWith(blobPrefix),
  );
  const batch = keys.slice(0, STORAGE_GC_LIMITS.objectsPerEntry);

  for (
    let index = 0;
    index < batch.length;
    index += STORAGE_GC_LIMITS.objectsPerDelete
  ) {
    await objects.removeMany(
      batch.slice(index, index + STORAGE_GC_LIMITS.objectsPerDelete),
    );
  }

  const complete = keys.length <= STORAGE_GC_LIMITS.objectsPerEntry;

  if (complete) {
    await onCollected?.(resource);
  }

  return {
    deletedObjects: batch.length,
    status: complete ? "complete" : "incomplete",
  };
}
