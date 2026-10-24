import type { PrerenderQueueRpc } from "@doxahq/contracts/docs-prerender-tasks";
import {
  DOCS_PRERENDER_RENDER_TARGET,
  docsPrerenderRenderResourceSchema,
  type DocsPrerenderRenderResource,
  type StorageCollector,
  type StorageGcCollection,
  type StorageGcInspection,
} from "@doxahq/contracts/storage-gc";

export interface DocsPrerenderRenderStore {
  isRenderCurrent(input: {
    siteId: string;
    renderId: string;
  }): Promise<boolean>;
}

export type DocsPrerenderRenderDeleter = Pick<
  PrerenderQueueRpc,
  "collectRender"
>;

/**
 * Deletes the stored objects of a pre-rendered production version.
 *
 * The collector keeps a render while any active production hostname of the
 * site still resolves to it. Deletion runs in the pre-render Worker, which
 * owns the only write binding for the derived-output bucket.
 */
export function createDocsPrerenderRenderCollector(input: {
  store: DocsPrerenderRenderStore;
  deleter: DocsPrerenderRenderDeleter;
}): StorageCollector<DocsPrerenderRenderResource> {
  return {
    target: DOCS_PRERENDER_RENDER_TARGET,
    parse(resource: unknown): DocsPrerenderRenderResource {
      return docsPrerenderRenderResourceSchema.parse(resource);
    },
    async inspect(
      resource: DocsPrerenderRenderResource,
    ): Promise<StorageGcInspection> {
      const current = await input.store.isRenderCurrent({
        siteId: resource.siteId,
        renderId: resource.renderId,
      });
      return current
        ? { status: "retain", reason: "render_serves_production" }
        : { status: "collect" };
    },
    collect(
      resource: DocsPrerenderRenderResource,
    ): Promise<StorageGcCollection> {
      return input.deleter.collectRender({
        siteId: resource.siteId,
        renderId: resource.renderId,
      });
    },
  };
}
