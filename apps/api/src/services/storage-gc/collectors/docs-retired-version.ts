import {
  DOCS_RETIRED_VERSION_TARGET,
  docsRetiredVersionResourceSchema,
  type DocsRetiredVersionResource,
  type StorageCollector,
} from "@doxahq/contracts/storage-gc";

import type { DocsVersionRetentionStore } from "../../../repositories/docs-version-retention";
import {
  collectVersionPrefix,
  type OnVersionPrefixCollected,
  type VersionObjects,
} from "./docs-version-prefix";

/**
 * Deletes the folder of a version that stopped serving: an old production
 * version, a replaced pull request preview, the staged version of a
 * discarded review, or the version of a deleted generation.
 *
 * The inspect step applies the retention policy of the project to every row
 * that shares the folder. A promotion shares its preview's folder, so the
 * folder of a promoted preview stays while production keeps the promotion.
 * When the folder goes, the inspect step marks the rows as collected first:
 * the history shows them as no longer restorable, and Promote refuses them.
 */
export function createDocsRetiredVersionCollector(input: {
  versions: Pick<
    DocsVersionRetentionStore,
    "claimRetiredVersionFolder" | "findFolderOwner"
  >;
  content: VersionObjects;
  onCollected?: OnVersionPrefixCollected;
  now?: () => Date;
}): StorageCollector<DocsRetiredVersionResource> {
  const now = input.now ?? (() => new Date());
  return {
    target: DOCS_RETIRED_VERSION_TARGET,
    parse: (resource) => docsRetiredVersionResourceSchema.parse(resource),
    inspect: (resource) =>
      input.versions.claimRetiredVersionFolder(resource, now()),
    async collect(resource) {
      const owner = await input.versions.findFolderOwner(resource);
      if (!owner) return { deletedObjects: 0, status: "complete" };
      return collectVersionPrefix(
        input.content,
        { siteId: resource.siteId, versionId: owner },
        input.onCollected,
      );
    },
  };
}
