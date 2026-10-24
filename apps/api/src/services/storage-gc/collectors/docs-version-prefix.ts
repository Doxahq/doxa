import {
  DOCS_ORPHAN_VERSION_PREFIX_TARGET,
  DOCS_PREVIEW_VERSION_TARGET,
  STORAGE_GC_LIMITS,
  docsOrphanVersionPrefixResourceSchema,
  docsPreviewVersionResourceSchema,
  type DocsOrphanVersionPrefixResource,
  type DocsPreviewVersionResource,
  type StorageCollector,
  type StorageGcCollection,
} from "@doxahq/contracts/storage-gc";
import { buildArtifactPrefix } from "@doxahq/docs-engine";

import type { DocsVersionGcStore } from "../../../repositories/docs-version-gc";
import type { DocsObjectStore } from "../../docs-content/store";

type VersionResource = DocsPreviewVersionResource;
export type VersionObjects = Pick<DocsObjectStore, "listKeys" | "removeMany">;

/**
 * Called after a folder is gone. The folder held a version tree, so some
 * blobs of the site can now be unreferenced.
 */
export type OnVersionPrefixCollected = (
  resource: VersionResource,
) => Promise<unknown>;

/** A live pointer can move, so a referenced preview is checked again later. */
export const REFERENCED_PREVIEW_RECHECK_SECONDS = 6 * 60 * 60;

export function createDocsPreviewVersionCollector(input: {
  versions: Pick<DocsVersionGcStore, "findPreviewVersionRetention">;
  content: VersionObjects;
  onCollected?: OnVersionPrefixCollected;
}): StorageCollector<DocsPreviewVersionResource> {
  return {
    target: DOCS_PREVIEW_VERSION_TARGET,
    parse: (resource) => docsPreviewVersionResourceSchema.parse(resource),
    async inspect(resource) {
      const retention =
        await input.versions.findPreviewVersionRetention(resource);

      if (retention === "referenced") {
        return {
          status: "retain",
          reason: "version_is_referenced",
          recheckAfterSeconds: REFERENCED_PREVIEW_RECHECK_SECONDS,
        };
      }

      return retention
        ? { status: "retain", reason: retention }
        : { status: "collect" };
    },
    collect: (resource) =>
      collectVersionPrefix(input.content, resource, input.onCollected),
  };
}

export function createDocsOrphanVersionPrefixCollector(input: {
  versions: Pick<DocsVersionGcStore, "isVersionPrefixInUse">;
  content: VersionObjects;
  onCollected?: OnVersionPrefixCollected;
}): StorageCollector<DocsOrphanVersionPrefixResource> {
  return {
    target: DOCS_ORPHAN_VERSION_PREFIX_TARGET,
    parse: (resource) => docsOrphanVersionPrefixResourceSchema.parse(resource),
    async inspect(resource) {
      const inUse = await input.versions.isVersionPrefixInUse(resource);

      return inUse
        ? { status: "retain", reason: "version_row_exists" }
        : { status: "collect" };
    },
    collect: (resource) =>
      collectVersionPrefix(input.content, resource, input.onCollected),
  };
}

/**
 * Deletes the physical keys of one folder: its `tree.json` and, before the
 * storage migration ends, its old flat files. Blobs live outside the folder.
 */
export async function collectVersionPrefix(
  content: VersionObjects,
  resource: VersionResource,
  onCollected: OnVersionPrefixCollected | undefined,
): Promise<StorageGcCollection> {
  const prefix = `${buildArtifactPrefix(resource.siteId, resource.versionId)}/`;
  const keys = await content.listKeys(prefix);
  const batch = keys.slice(0, STORAGE_GC_LIMITS.objectsPerEntry);

  for (
    let index = 0;
    index < batch.length;
    index += STORAGE_GC_LIMITS.objectsPerDelete
  ) {
    await content.removeMany(
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
