import {
  createBucketCodeReader,
  type RendererCodeReader,
} from "./renderer-code-package";
import type { CacheEntrypoint } from "./worker-exports";

/**
 * Increase this value when the cached response changes shape. With
 * `cross_version_cache`, older and newer deploys share one key otherwise.
 */
export const RENDERER_CODE_CACHE_FORMAT = 1;

const RENDERER_CODE_CACHE_ORIGIN = "https://renderer-code.internal";

/**
 * Set only by the dispatcher, from its own deploy variables. Together with the
 * URL, they form the cache key. No visitor value reaches them.
 */
export interface RendererCodeCacheProps {
  buildId: string;
  objectKey: string;
  format: number;
}

/** `cf-cache-status` values that mean the bytes came from a stored copy. */
const CACHE_HIT_STATUSES: ReadonlySet<string> = new Set([
  "HIT",
  "STALE",
  "UPDATING",
  "REVALIDATED",
]);

export function createRendererCodeCacheUrl(buildId: string): string {
  return `${RENDERER_CODE_CACHE_ORIGIN}/v${RENDERER_CODE_CACHE_FORMAT}/${encodeURIComponent(buildId)}`;
}

/**
 * The readers of one cold start: Workers Cache first, then the bucket. The
 * cache reader reports `cache` for a stored copy and `r2` for a fill.
 */
export function createRendererCodeReaders(input: {
  cache: CacheEntrypoint<RendererCodeCacheProps>;
  bucket: R2Bucket;
  buildId: string;
  objectKey: string;
}): RendererCodeReader[] {
  return [
    createCachedCodeReader(input),
    createBucketCodeReader(input.bucket, input.objectKey),
  ];
}

function createCachedCodeReader(input: {
  cache: CacheEntrypoint<RendererCodeCacheProps>;
  buildId: string;
  objectKey: string;
}): RendererCodeReader {
  return async () => {
    const response = await input
      .cache({
        props: {
          buildId: input.buildId,
          objectKey: input.objectKey,
          format: RENDERER_CODE_CACHE_FORMAT,
        },
      })
      .fetch(createRendererCodeCacheUrl(input.buildId));
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`The renderer code cache answered ${response.status}.`);
    }
    const status = response.headers.get("cf-cache-status") ?? "";
    return {
      body: response.body,
      source: CACHE_HIT_STATUSES.has(status.toUpperCase()) ? "cache" : "r2",
    };
  };
}
