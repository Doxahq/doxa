import { waitUntil } from "cloudflare:workers";
import {
  createVersionTreeReader,
  workerVersionCaches,
  workersDefaultCache,
  type VersionTreeReader,
} from "@doxahq/docs-engine";

const readers = new WeakMap<object, VersionTreeReader>();

/**
 * Reads logical artifact keys (`{artifactPrefix}/{path}`) through the version
 * tree of each folder. One reader lives per bucket binding and isolate.
 *
 * Trees are kept in memory, then in the Workers cache of the data center that
 * serves the reader. Small blobs are kept in that Workers cache. So a page
 * render after a renderer deploy reads no R2 object for content that the data
 * center already read.
 *
 * Site assets do not use this reader. They live outside version folders.
 */
export function artifactReader(bucket: R2Bucket): VersionTreeReader {
  let reader = readers.get(bucket);

  if (!reader) {
    reader = createVersionTreeReader(
      bucket,
      workerVersionCaches(bucket, {
        edgeCache: workersDefaultCache(),
        // The request's own `waitUntil`, read when a cache fill starts.
        waitUntil: (promise) => waitUntil(promise),
        // The runtime caches parsed configs and route data above the reader.
        memoryBlobs: false,
      }),
    );
    readers.set(bucket, reader);
  }

  return reader;
}
