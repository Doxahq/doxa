import { createPrerenderRenderPrefix } from "@doxahq/contracts/docs-prerender";
import {
  docsPrerenderRenderResourceSchema,
  STORAGE_GC_LIMITS,
  type StorageGcCollection,
} from "@doxahq/contracts/storage-gc";

export interface PrerenderDeleteBucket {
  list(options: {
    prefix: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    objects: readonly { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string[]): Promise<void>;
}

export interface CollectPrerenderRenderInput {
  bucket: PrerenderDeleteBucket;
  siteId: string;
  renderId: string;
  limit?: number;
}

/**
 * Deletes the manifest and every content object of one render.
 *
 * The prefix comes from the validated site and render identity, so a caller
 * cannot reach another render or another site.
 */
export async function collectPrerenderRender(
  input: CollectPrerenderRenderInput,
): Promise<StorageGcCollection> {
  const resource = docsPrerenderRenderResourceSchema.parse({
    siteId: input.siteId,
    renderId: input.renderId,
  });
  const prefix = createPrerenderRenderPrefix(
    resource.siteId,
    resource.renderId,
  );
  const limit = readObjectLimit(input.limit);

  let deletedObjects = 0;
  let cursor: string | undefined;
  while (deletedObjects < limit) {
    const page = await input.bucket.list({
      prefix,
      limit: Math.min(
        STORAGE_GC_LIMITS.objectsPerDelete,
        limit - deletedObjects,
      ),
      ...(cursor ? { cursor } : {}),
    });
    const keys = page.objects
      .map((object) => object.key)
      .filter((key) => key.startsWith(prefix));
    if (keys.length > 0) {
      await input.bucket.delete(keys);
      deletedObjects += keys.length;
    }
    if (!page.truncated || !page.cursor) {
      return { deletedObjects, status: "complete" };
    }
    // Deleted keys leave the listing, so the next page starts at the prefix
    // again. A cursor is only necessary when nothing was deleted.
    cursor = keys.length > 0 ? undefined : page.cursor;
  }
  return { deletedObjects, status: "incomplete" };
}

function readObjectLimit(value: number | undefined): number {
  if (value === undefined) return STORAGE_GC_LIMITS.objectsPerEntry;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("The collection limit is invalid.");
  }
  return Math.min(value, STORAGE_GC_LIMITS.objectsPerEntry);
}
