import { respondWithVersionObject } from "@doxahq/docs-engine";
import { WorkerEntrypoint } from "cloudflare:workers";

interface BlobCacheEnv {
  DOCS_BUCKET: R2Bucket;
}

/**
 * The tiered Workers Cache in front of the blobs and trees of published
 * versions. `wrangler.json` enables the cache for this entrypoint only.
 *
 * The runtime calls it through `ctx.exports.DocsBlobCache.fetch()`, so a read
 * that misses its own data center can still hit the regional upper tier
 * before R2. It runs only on a miss in every tier. It has no public route:
 * the default fetch handler never forwards to it.
 *
 * It accepts only the blob and tree keys of the version tree layer and
 * caches only bytes that match their key. See `respondWithVersionObject`.
 */
export class DocsBlobCache extends WorkerEntrypoint<BlobCacheEnv> {
  fetch(request: Request): Promise<Response> {
    return respondWithVersionObject(this.env.DOCS_BUCKET, request);
  }
}
