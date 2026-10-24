import {
  DOCS_SITE_BLOBS_TARGET,
  STORAGE_GC_LIMITS,
  docsSiteBlobsResourceSchema,
  type DocsSiteBlobsResource,
  type StorageCollector,
  type StorageGcCollection,
} from "@doxahq/contracts/storage-gc";
import {
  VERSION_TREE_FILE_NAME,
  parseVersionArtifactKey,
  parseVersionTreeText,
  siteBlobPrefix,
} from "@doxahq/docs-engine";

import type { DocsObjectStore } from "../../docs-content/store";

/**
 * A publish uploads its blobs before its tree exists. It finishes in minutes,
 * so a blob younger than this age can belong to a running publish.
 */
export const BLOB_IN_FLIGHT_SECONDS = 60 * 60;

/**
 * Mark and sweep for the content-addressed blobs of one site.
 *
 * Every `tree.json` in a version folder of the site marks its blobs. A blob
 * that no tree marks, and that is older than `BLOB_IN_FLIGHT_SECONDS`, is
 * deleted. An invalid tree stops the sweep before any deletion, because an
 * unreadable tree can still reference any blob.
 */
export function createDocsSiteBlobsCollector(input: {
  objects: Pick<DocsObjectStore, "listObjects" | "read" | "removeMany">;
  now?: () => Date;
}): StorageCollector<DocsSiteBlobsResource> {
  const now = input.now ?? (() => new Date());

  return {
    target: DOCS_SITE_BLOBS_TARGET,
    parse: (resource) => docsSiteBlobsResourceSchema.parse(resource),
    inspect: async () => ({ status: "collect" }),
    collect: (resource) => sweepSiteBlobs(input.objects, resource, now()),
  };
}

async function sweepSiteBlobs(
  objects: Pick<DocsObjectStore, "listObjects" | "read" | "removeMany">,
  resource: DocsSiteBlobsResource,
  startedAt: Date,
): Promise<StorageGcCollection> {
  const blobPrefix = siteBlobPrefix(resource.siteId);
  // Blobs are listed before trees. A tree committed after this list can only
  // reference a listed blob that its writer uploaded again, and the writer
  // restores such a blob after its commit.
  const blobs = await objects.listObjects(blobPrefix);
  const referenced = await referencedBlobs(objects, resource.siteId);
  const cutoff = startedAt.getTime() - BLOB_IN_FLIGHT_SECONDS * 1000;
  const unreferenced = blobs.filter(
    ({ key }) => !referenced.has(key.slice(blobPrefix.length)),
  );
  const expired = unreferenced.filter(
    ({ uploaded }) => uploaded.getTime() <= cutoff,
  );
  const batch = expired
    .slice(0, STORAGE_GC_LIMITS.objectsPerEntry)
    .map(({ key }) => key);

  for (
    let index = 0;
    index < batch.length;
    index += STORAGE_GC_LIMITS.objectsPerDelete
  ) {
    await objects.removeMany(
      batch.slice(index, index + STORAGE_GC_LIMITS.objectsPerDelete),
    );
  }

  if (expired.length > batch.length) {
    return { deletedObjects: batch.length, status: "incomplete" };
  }

  if (unreferenced.length > expired.length) {
    return {
      deletedObjects: batch.length,
      status: "incomplete",
      recheckAfterSeconds: BLOB_IN_FLIGHT_SECONDS,
    };
  }

  return { deletedObjects: batch.length, status: "complete" };
}

async function referencedBlobs(
  objects: Pick<DocsObjectStore, "listObjects" | "read">,
  siteId: string,
): Promise<Set<string>> {
  const referenced = new Set<string>();
  const listed = await objects.listObjects(`sites/${siteId}/versions/`);

  for (const { key } of listed) {
    const parts = parseVersionArtifactKey(key);

    // Only the tree at the root of a folder marks blobs. Old flat files of a
    // folder stay until the storage migration prunes them.
    if (parts?.path !== VERSION_TREE_FILE_NAME) {
      continue;
    }

    const text = await objects.read(key);

    // A folder collector can delete the tree after the list. That tree no
    // longer protects its blobs.
    if (text === null) {
      continue;
    }

    const tree = parseVersionTreeText(text, parts);

    for (const entry of Object.values(tree.files)) {
      referenced.add(entry.sha256);
    }
  }

  return referenced;
}
