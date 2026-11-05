import type { StorageCollector } from "@doxahq/contracts/storage-gc";

import type { Env } from "../../env";
import { DocsPrerenderTasksRepository } from "../../repositories/docs-prerender-tasks";
import { DocsSearchIndexesRepository } from "../../repositories/docs-search-indexes";
import { createDocsSearchWriters } from "../docs-search/providers";
import { DocsVersionGcRepository } from "../../repositories/docs-version-gc";
import { DocsVersionGcEntriesRepository } from "../../repositories/docs-version-gc-entries";
import { DocsVersionRetentionRepository } from "../../repositories/docs-version-retention";
import { StorageGcRepository } from "../../repositories/storage-gc";
import { createR2DocsObjectStore } from "../docs-content/store";
import { createDocsBranchAssetFolderCollector } from "./collectors/docs-branch-asset-folder";
import { createDocsDeletedSiteCollector } from "./collectors/docs-deleted-site";
import { createDocsGenerationStateCollector } from "./collectors/docs-generation-state";
import { createDocsPrerenderRenderCollector } from "./collectors/docs-prerender-render";
import { createDocsRetiredVersionCollector } from "./collectors/docs-retired-version";
import { createDocsSearchIndexCollector } from "./collectors/docs-search-index";
import { createDocsSiteBlobsCollector } from "./collectors/docs-site-blobs";
import {
  createDocsOrphanVersionPrefixCollector,
  createDocsPreviewVersionCollector,
} from "./collectors/docs-version-prefix";
import { StorageGarbageCollector } from "./runner";

export { StorageGarbageCollector } from "./runner";
export { createDocsBranchAssetFolderCollector } from "./collectors/docs-branch-asset-folder";
export { createDocsDeletedSiteCollector } from "./collectors/docs-deleted-site";
export { createDocsGenerationStateCollector } from "./collectors/docs-generation-state";
export { createDocsRetiredVersionCollector } from "./collectors/docs-retired-version";
export { createDocsPrerenderRenderCollector } from "./collectors/docs-prerender-render";
export { createDocsSiteBlobsCollector } from "./collectors/docs-site-blobs";
export {
  createDocsOrphanVersionPrefixCollector,
  createDocsPreviewVersionCollector,
} from "./collectors/docs-version-prefix";

/**
 * Registers every collector this deployment can run.
 *
 * A new feature adds one entry here. It needs no scheduler, no table, and no
 * retry logic of its own.
 */
export function createStorageCollectors(env: Env): StorageCollector[] {
  const versions = new DocsVersionGcRepository(env);
  const gcEntries = new DocsVersionGcEntriesRepository(env);
  const retention = new DocsVersionRetentionRepository(env);
  // Collectors delete real keys, so they use the physical store.
  const content = createR2DocsObjectStore(env.DOCS_BUCKET);
  const onCollected = ({ siteId }: { siteId: string }) =>
    gcEntries.enqueueSiteBlobs({ siteId }, "version_prefix_collected");
  const collectors: StorageCollector[] = [
    createDocsPreviewVersionCollector({ versions, content, onCollected }),
    createDocsOrphanVersionPrefixCollector({ versions, content, onCollected }),
    createDocsBranchAssetFolderCollector({ versions, content, onCollected }),
    createDocsRetiredVersionCollector({
      versions: retention,
      content,
      onCollected,
    }) as StorageCollector,
    createDocsGenerationStateCollector({
      versions: retention,
      objects: content,
    }) as StorageCollector,
    createDocsSiteBlobsCollector({ objects: content }) as StorageCollector,
    createDocsDeletedSiteCollector({
      sites: versions,
      objects: content,
      onCollected: ({ siteId }) =>
        gcEntries.enqueueSiteBlobs({ siteId }, "deleted_site_collected"),
    }) as StorageCollector,
  ];
  const searchWriters = createDocsSearchWriters(env);
  if (Object.keys(searchWriters).length > 0) {
    collectors.push(
      createDocsSearchIndexCollector({
        indexes: new DocsSearchIndexesRepository(env),
        writers: searchWriters,
      }) as StorageCollector,
    );
  }
  if (env.PRERENDER_QUEUE) {
    collectors.push(
      createDocsPrerenderRenderCollector({
        store: new DocsPrerenderTasksRepository(env),
        deleter: env.PRERENDER_QUEUE,
      }) as StorageCollector,
    );
  }
  return collectors;
}

export function createStorageGarbageCollector(
  env: Env,
): StorageGarbageCollector {
  return new StorageGarbageCollector(
    new StorageGcRepository(env),
    createStorageCollectors(env),
  );
}
