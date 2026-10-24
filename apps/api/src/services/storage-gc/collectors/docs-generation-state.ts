import {
  DOCS_GENERATION_STATE_TARGET,
  STORAGE_GC_LIMITS,
  docsGenerationStateResourceSchema,
  type DocsGenerationStateResource,
  type StorageCollector,
} from "@doxahq/contracts/storage-gc";

import {
  generationStatePrefixOf,
  type DocsVersionRetentionStore,
} from "../../../repositories/docs-version-retention";
import type { VersionObjects } from "./docs-version-prefix";

/**
 * Deletes the generation state that one version wrote. The state stays while
 * any version that names it can be a baseline: the published version, a
 * version in the rollback window, the staged version of an open review, a
 * current or promotable preview, a branch base, or the baseline of a running
 * generation.
 */
export function createDocsGenerationStateCollector(input: {
  versions: Pick<DocsVersionRetentionStore, "inspectGenerationState">;
  objects: VersionObjects;
  now?: () => Date;
}): StorageCollector<DocsGenerationStateResource> {
  const now = input.now ?? (() => new Date());
  return {
    target: DOCS_GENERATION_STATE_TARGET,
    parse: (resource) => docsGenerationStateResourceSchema.parse(resource),
    inspect: (resource) => input.versions.inspectGenerationState(resource, now()),
    async collect(resource) {
      const keys = await input.objects.listKeys(
        `${generationStatePrefixOf(resource)}/`,
      );
      const batch = keys.slice(0, STORAGE_GC_LIMITS.objectsPerEntry);
      for (
        let index = 0;
        index < batch.length;
        index += STORAGE_GC_LIMITS.objectsPerDelete
      ) {
        await input.objects.removeMany(
          batch.slice(index, index + STORAGE_GC_LIMITS.objectsPerDelete),
        );
      }
      return {
        deletedObjects: batch.length,
        status:
          keys.length <= STORAGE_GC_LIMITS.objectsPerEntry
            ? "complete"
            : "incomplete",
      };
    },
  };
}
