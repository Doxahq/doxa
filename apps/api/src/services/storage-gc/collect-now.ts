import type { Env } from "../../env";
import { createStorageGarbageCollector } from "./index";

/**
 * Collects work-list entries at once, after the commit that queued them.
 *
 * The request that released a resource must not fail because of storage.
 * A failure is logged, and the scheduled run collects the entries later.
 */
export type CollectStorageNow = (entryIds: readonly string[]) => Promise<void>;

export function createCollectStorageNow(env: Env): CollectStorageNow {
  return async (entryIds) => {
    if (entryIds.length === 0) return;

    try {
      await createStorageGarbageCollector(env).collectNow(entryIds);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "storage_gc_immediate_collection_deferred",
          entryCount: entryIds.length,
          errorClass: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    }
  };
}
