import { R2_CACHE_REFRESH_AFTER_DAYS } from "@doxahq/contracts/storage-lifecycle";

const DAY_MS = 24 * 60 * 60 * 1_000;

/** An R2 cache object that a lookup just read. */
export interface ReadCacheObject {
  key: string;
  uploaded: Date;
  body: string;
  contentType: string;
}

interface CacheRefreshBucket {
  put(
    key: string,
    value: string,
    options?: R2PutOptions,
  ): Promise<R2Object | null>;
}

/**
 * True when a cache object is old enough to write again. R2 lifecycle rules
 * count the age from the upload, not from the last read.
 */
export function cacheObjectNeedsRefresh(uploaded: Date, now: Date): boolean {
  return now.getTime() - uploaded.getTime() >= R2_CACHE_REFRESH_AFTER_DAYS * DAY_MS;
}

/**
 * Writes an aging cache object again with the same bytes, so an entry that
 * lookups still hit never expires. A failed refresh only leaves the entry to
 * expire, so it never fails the lookup.
 */
export async function refreshAgingCacheObject(
  bucket: CacheRefreshBucket,
  object: ReadCacheObject,
  now: Date,
): Promise<boolean> {
  try {
    if (!cacheObjectNeedsRefresh(object.uploaded, now)) return false;
    await bucket.put(object.key, object.body, {
      httpMetadata: { contentType: object.contentType },
    });
    return true;
  } catch {
    return false;
  }
}
