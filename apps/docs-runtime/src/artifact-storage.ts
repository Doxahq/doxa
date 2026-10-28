import { waitUntil } from "cloudflare:workers";
import {
  createVersionObjectStorage,
  createVersionTreeReader,
  workerVersionCaches,
  workersDefaultCache,
  type EdgeCache,
  type VersionObjectFetcher,
  type VersionTreeReader,
} from "@doxahq/docs-engine";
import {
  readBlobCacheRollout,
  usesBlobCache,
  type BlobCacheRolloutEnv,
} from "./blob-cache-rollout";

export interface ArtifactStorageEnv extends BlobCacheRolloutEnv {
  DOCS_BUCKET: R2Bucket;
}

/**
 * Where one storage read was served: the Workers cache of the data center
 * (`caches.default`), the tiered `DocsBlobCache`, or R2. A tiered-cache miss
 * reads R2 and counts as `r2`.
 */
export type ArtifactReadSource = "edgeCache" | "blobCache" | "r2";

export interface ArtifactReaderOptions {
  /** `ctx.exports.DocsBlobCache` of the current request. */
  readonly blobCache?: VersionObjectFetcher | null;
  readonly onRead?: (source: ArtifactReadSource) => void;
}

/**
 * Reads logical artifact keys (`{artifactPrefix}/{path}`) through the version
 * tree of each folder. Create one reader per request: it carries the
 * request's own `DocsBlobCache` binding and read counter. The caches below
 * belong to the bucket binding, so every reader of an isolate shares them.
 *
 * A read goes through these tiers, and stops at the first that holds it:
 *
 * 1. Parsed trees in the memory of the isolate.
 * 2. Trees and small blobs in the Workers cache of the data center. It is
 *    local and costs no request, so it stays in front of the tiered cache.
 * 3. `DocsBlobCache`, when the rollout includes the site: a Workers Cache
 *    entrypoint with a regional upper tier.
 * 4. R2.
 *
 * Site assets do not use this reader. They live outside version folders.
 */
export function artifactReader(
  env: ArtifactStorageEnv,
  options: ArtifactReaderOptions = {},
): VersionTreeReader {
  const bucket = env.DOCS_BUCKET;
  const rollout = readBlobCacheRollout(env);
  const report = (source: ArtifactReadSource) => options.onRead?.(source);

  return createVersionTreeReader(
    createVersionObjectStorage(bucket, {
      cache: rollout.mode === "off" ? null : options.blobCache,
      useCache: (key) => usesBlobCache(rollout, key.siteId),
      onRead: (source) => report(source === "cache" ? "blobCache" : "r2"),
    }),
    workerVersionCaches(bucket, {
      edgeCache: countHits(workersDefaultCache(), () => report("edgeCache")),
      // The request's own `waitUntil`, read when a cache fill starts.
      waitUntil: (promise) => waitUntil(promise),
      // The runtime caches parsed configs and route data above the reader.
      memoryBlobs: false,
    }),
  );
}

/** The edge cache, reporting each hit. */
function countHits(
  cache: EdgeCache | null,
  onHit: () => void,
): EdgeCache | null {
  if (!cache) return null;

  return {
    async match(...args: Parameters<EdgeCache["match"]>) {
      const cached = await cache.match(...args);
      if (cached) onHit();
      return cached;
    },
    put: (...args: Parameters<EdgeCache["put"]>) => cache.put(...args),
  };
}
