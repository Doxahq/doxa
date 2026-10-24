import { vi } from "vitest";
import {
  parseVersionArtifactKey,
  siteBlobKey,
  writeVersionTree,
  type VersionTree,
  type VersionTreeStorage,
} from "@doxahq/docs-engine";

const DEFAULT_CONTENT_TYPE = "text/plain; charset=utf-8";

interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

export interface TreeBucket {
  bucket: R2Bucket;
  /** The blob key that serves a logical version key. */
  blobKeyOf(logicalKey: string): Promise<string>;
}

const buckets = new WeakMap<object, TreeBucket>();

/**
 * Stores logical artifact files the way publication stores them: one tree and
 * content-addressed blobs per version folder, written by the real writer.
 * Keys outside version folders, such as site assets, stay raw.
 *
 * The bucket builds its trees on its first call, so a test can create it at
 * describe time. When a test changes `objects` later, the next call builds
 * the trees again, as a new publication would. `get` is a spy.
 */
export function createTreeBucket(
  objects: Record<string, string>,
  contentTypes: Record<string, string> = {},
): TreeBucket {
  const physical = new Map<string, StoredObject>();
  const trees = new Map<string, VersionTree>();
  let ready: Promise<void> | null = null;
  let builtFrom = "";

  const storage: Pick<VersionTreeStorage, "put" | "head"> = {
    async put(key, value, options) {
      physical.set(key, {
        bytes: typeof value === "string" ? encode(value) : value,
        contentType: options?.httpMetadata?.contentType ?? DEFAULT_CONTENT_TYPE,
      });
    },
    async head(key) {
      return physical.has(key) ? {} : null;
    },
  };

  const build = async () => {
    const versions = new Map<
      string,
      { siteId: string; versionId: string; files: { path: string; content: string; contentType: string }[] }
    >();

    for (const [key, content] of Object.entries(objects)) {
      const parts = parseVersionArtifactKey(key);
      const contentType = contentTypes[key] ?? DEFAULT_CONTENT_TYPE;

      if (!parts) {
        physical.set(key, { bytes: encode(content), contentType });
        continue;
      }

      const version = versions.get(parts.prefix) ?? {
        siteId: parts.siteId,
        versionId: parts.versionId,
        files: [],
      };
      version.files.push({ path: parts.path, content, contentType });
      versions.set(parts.prefix, version);
    }

    for (const [prefix, version] of versions) {
      trees.set(prefix, (await writeVersionTree(storage, version)).tree);
    }
  };

  const whenReady = () => {
    const signature = JSON.stringify(objects);

    if (!ready || signature !== builtFrom) {
      builtFrom = signature;
      ready = build();
    }

    return ready;
  };

  const bucket = {
    get: vi.fn(async (key: string) => {
      await whenReady();
      const object = physical.get(key);
      return object ? r2Object(object) : null;
    }),
    async head(key: string) {
      await whenReady();
      return physical.has(key) ? {} : null;
    },
  };

  const treeBucket: TreeBucket = {
    bucket: bucket as unknown as R2Bucket,
    async blobKeyOf(logicalKey) {
      await whenReady();
      const parts = parseVersionArtifactKey(logicalKey);
      const entry = parts ? trees.get(parts.prefix)?.files[parts.path] : null;

      if (!parts || !entry) {
        throw new Error(`No stored file for ${logicalKey}`);
      }

      return siteBlobKey(parts.siteId, entry.sha256);
    },
  };
  buckets.set(bucket, treeBucket);
  return treeBucket;
}

/** The helper of a bucket that `createTreeBucket` made. */
export function treeBucketOf(bucket: R2Bucket): TreeBucket {
  const treeBucket = buckets.get(bucket);

  if (!treeBucket) {
    throw new Error("The bucket was not made by createTreeBucket.");
  }

  return treeBucket;
}

function r2Object(object: StoredObject) {
  return {
    text: async () => new TextDecoder().decode(object.bytes),
    arrayBuffer: async () => object.bytes.slice().buffer,
    body: new Response(object.bytes.slice()).body,
    size: object.bytes.byteLength,
    httpMetadata: { contentType: object.contentType },
  };
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
