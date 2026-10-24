import {
  VersionTreeWriter,
  createVersionTreeReader,
  parseVersionArtifactKey,
  workerVersionCaches,
  workersDefaultCache,
  VERSION_TREE_FILE_NAME,
  type VersionTreeReader,
  type VersionTreeStorage,
  type WaitUntil,
} from "@doxahq/docs-engine";
import type { MeasureStep } from "../request-timing";

export interface R2DocsReadOptions {
  /**
   * Keeps work alive after the response, such as a cache fill. Without it, a
   * fill may stop when the request ends, and the next read fills again.
   */
  waitUntil?: WaitUntil;
  /** Measures the version tree reads from R2 as `r2.tree`. */
  measure?: MeasureStep;
}

/**
 * Reads logical artifact keys with their content type. Use it where a caller
 * needs the object, for example to serve an artifact over HTTP or RPC.
 *
 * Trees and small blobs are kept in the memory of the isolate, then in the
 * Workers cache of the data center (see `workerVersionCaches`). A tree read
 * that the caches answer makes no R2 call, so it has no `r2.tree` step.
 */
export function createR2DocsArtifactReader(
  bucket: R2Bucket,
  options: R2DocsReadOptions = {},
): VersionTreeReader {
  return createVersionTreeReader(
    measuredTreeReads(bucket, options.measure),
    workerVersionCaches(bucket, {
      edgeCache: workersDefaultCache(),
      waitUntil: options.waitUntil,
    }),
  );
}

function measuredTreeReads(
  bucket: R2Bucket,
  measure: MeasureStep | undefined,
): Pick<VersionTreeStorage, "get"> {
  if (!measure) return bucket;

  const suffix = `/${VERSION_TREE_FILE_NAME}`;
  return {
    get: (key) =>
      key.endsWith(suffix)
        ? measure("r2.tree", () => bucket.get(key))
        : bucket.get(key),
  };
}

/**
 * Logical storage boundary for docs content.
 *
 * Services address an artifact with its logical key
 * `sites/{siteId}/versions/{versionId}/{path}`. In the Worker, the R2
 * implementation resolves that key through the version tree and reads the
 * content-addressed blob. Tests use an in-memory implementation of the same
 * logical keys, so publication can be verified without a bucket.
 *
 * Published versions are immutable. A new version is created only through
 * `openVersion`, and it becomes visible when `commit` returns.
 */
export interface DocsContentStore {
  read(key: string): Promise<string | null>;
  readBytes(key: string): Promise<Uint8Array | null>;
  /** Logical keys under a prefix. Version prefixes list from the tree. */
  listKeys(prefix: string): Promise<string[]>;
  /**
   * The bytes of all files of one version, from its tree. Null when the
   * version has no tree.
   */
  versionSize(artifactPrefix: string): Promise<number | null>;
  openVersion(input: OpenDocsVersionInput): Promise<DocsVersionWriter>;
}

export interface OpenDocsVersionInput {
  siteId: string;
  versionId: string;
  /** The folder that `copy` reuses. It must belong to the same site. */
  basePrefix?: string | null;
}

export interface DocsVersionWriter {
  readonly artifactPrefix: string;
  put(
    path: string,
    content: string | Uint8Array,
    contentType?: string,
  ): Promise<void>;
  /** Reuses `path` of the base folder unchanged. */
  copy(path: string): Promise<void>;
  /**
   * Reuses `path` of another committed folder of the same site, without a
   * read or a write of the file. A branch asset comes from its upload folder.
   */
  copyFrom(sourcePrefix: string, path: string): Promise<void>;
  commit(): Promise<{ artifactPrefix: string; manifestPath: string }>;
}

/**
 * Physical storage for the parts that must see real object keys: the
 * garbage collector and the storage migration. Services never use it.
 */
export interface DocsObjectStore {
  read(key: string): Promise<string | null>;
  readBytes(key: string): Promise<Uint8Array | null>;
  readObject(
    key: string,
  ): Promise<{ bytes: Uint8Array; contentType: string | undefined } | null>;
  write(
    key: string,
    value: string | Uint8Array,
    contentType?: string,
  ): Promise<void>;
  stat(key: string): Promise<{ size: number } | null>;
  listKeys(prefix: string): Promise<string[]>;
  listObjects(prefix: string): Promise<DocsStoredObject[]>;
  removeMany(keys: readonly string[]): Promise<void>;
}

export interface DocsStoredObject {
  key: string;
  size: number;
  uploaded: Date;
}

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";
const R2_LIST_PAGE_SIZE = 1000;

export function createR2DocsContentStore(
  bucket: R2Bucket,
  options: R2DocsReadOptions = {},
): DocsContentStore {
  const reader = createR2DocsArtifactReader(bucket, options);
  const objects = createR2DocsObjectStore(bucket);

  return {
    async read(key) {
      const object = await reader.get(assertSafeArtifactKey(key));
      return object ? object.text() : null;
    },

    async readBytes(key) {
      const object = await reader.get(assertSafeArtifactKey(key));
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },

    async listKeys(prefix) {
      const safePrefix = assertSafeArtifactKey(prefix);

      // A version without a tree does not exist, so it has no keys.
      if (parseVersionArtifactKey(safePrefix)) {
        return (await reader.listVersionKeys(safePrefix)) ?? [];
      }

      return objects.listKeys(safePrefix);
    },

    async versionSize(artifactPrefix) {
      const tree = await reader.readTree(assertSafeArtifactKey(artifactPrefix));
      return tree
        ? Object.values(tree.files).reduce((sum, file) => sum + file.size, 0)
        : null;
    },

    openVersion: (input) => openR2Version(bucket, reader, input),
  };
}

async function openR2Version(
  bucket: R2Bucket,
  reader: VersionTreeReader,
  input: OpenDocsVersionInput,
): Promise<DocsVersionWriter> {
  const basePrefix = input.basePrefix
    ? assertSafeArtifactKey(input.basePrefix)
    : null;
  const base = basePrefix ? await reader.readTree(basePrefix) : null;

  if (basePrefix && !base) {
    throw new Error(`The base version ${basePrefix} has no tree.`);
  }

  const writer = new VersionTreeWriter(bucket, {
    siteId: input.siteId,
    versionId: input.versionId,
    base,
  });

  return {
    artifactPrefix: writer.artifactPrefix,

    async put(path, content, contentType = contentTypeForKey(path)) {
      await writer.put(path, content, contentType);
    },

    async copy(path) {
      writer.copy(path);
    },

    async copyFrom(sourcePrefix, path) {
      const source = await reader.readTree(assertSafeArtifactKey(sourcePrefix));

      if (!source) {
        throw new Error(`The folder ${sourcePrefix} has no tree.`);
      }

      // The writer refuses a tree of another site.
      writer.copy(path, source);
    },

    async commit() {
      const { artifactPrefix, manifestPath } = await writer.commit();
      return { artifactPrefix, manifestPath };
    },
  };
}

export function createR2DocsObjectStore(bucket: R2Bucket): DocsObjectStore {
  const listObjects = async (prefix: string): Promise<DocsStoredObject[]> => {
    const safePrefix = assertSafeArtifactKey(prefix);
    const objects: DocsStoredObject[] = [];
    let cursor: string | undefined;

    do {
      const page = await bucket.list({
        prefix: safePrefix,
        limit: R2_LIST_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      for (const object of page.objects) {
        objects.push({
          key: object.key,
          size: object.size,
          uploaded: object.uploaded,
        });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    return objects;
  };

  return {
    async read(key) {
      const object = await bucket.get(assertSafeArtifactKey(key));
      return object ? object.text() : null;
    },

    async readBytes(key) {
      const object = await bucket.get(assertSafeArtifactKey(key));
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },

    async readObject(key) {
      const object = await bucket.get(assertSafeArtifactKey(key));
      return object
        ? {
            bytes: new Uint8Array(await object.arrayBuffer()),
            contentType: object.httpMetadata?.contentType,
          }
        : null;
    },

    async write(key, value, contentType = contentTypeForKey(key)) {
      await bucket.put(assertSafeArtifactKey(key), value, {
        httpMetadata: { contentType },
      });
    },

    async stat(key) {
      const object = await bucket.head(assertSafeArtifactKey(key));
      return object ? { size: object.size } : null;
    },

    async listKeys(prefix) {
      return (await listObjects(prefix)).map(({ key }) => key);
    },

    listObjects,

    async removeMany(keys) {
      if (keys.length > 0) {
        await bucket.delete(keys.map(assertSafeArtifactKey));
      }
    },
  };
}

/**
 * Serves repeated `read` calls for one key from memory.
 *
 * Create one per request and never share it between requests. The store
 * cannot change a published artifact. A commit makes a new version visible, so
 * the cache forgets every key of that version at its commit. Concurrent reads
 * of a key share one bucket call. A failed read is not kept.
 */
export function withRequestReadCache(
  store: DocsContentStore,
): DocsContentStore {
  const reads = new Map<string, Promise<string | null>>();

  return {
    ...store,
    async openVersion(input) {
      const writer = await store.openVersion(input);

      return {
        artifactPrefix: writer.artifactPrefix,
        put: (path, content, contentType) =>
          writer.put(path, content, contentType),
        copy: (path) => writer.copy(path),
        copyFrom: (sourcePrefix, path) => writer.copyFrom(sourcePrefix, path),
        async commit() {
          const committed = await writer.commit();
          const prefix = `${committed.artifactPrefix}/`;
          for (const key of reads.keys()) {
            if (key.startsWith(prefix)) reads.delete(key);
          }
          return committed;
        },
      };
    },
    read(key) {
      const cached = reads.get(key);

      if (cached) {
        return cached;
      }

      const pending = store.read(key);
      reads.set(key, pending);
      pending.catch(() => {
        if (reads.get(key) === pending) reads.delete(key);
      });
      return pending;
    },
  };
}

export function contentTypeForKey(key: string): string {
  return key.endsWith(".json") ? JSON_CONTENT_TYPE : TEXT_CONTENT_TYPE;
}

/**
 * Rejects traversal before any bucket call. Every key reaching the store is
 * built from a resolved site id, so a key that escapes its prefix means a
 * defect, not a recoverable request error.
 */
export function assertSafeArtifactKey(key: string): string {
  const trimmed = key.trim().replace(/^\/+/, "");
  if (!trimmed || trimmed.includes("..") || trimmed.includes("\\")) {
    throw new Error(`Unsafe docs artifact key: ${key}`);
  }
  return trimmed;
}
