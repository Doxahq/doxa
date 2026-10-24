import { z } from "zod";

/**
 * Content-addressed storage for published docs versions.
 *
 * A version folder holds one `tree.json`. The tree maps every artifact path
 * of the version to a blob. A blob is stored once per site under the SHA-256
 * hash of its bytes, so a new version writes only the files that changed.
 *
 * Readers keep the logical key `{artifactPrefix}/{path}`. The reader in this
 * module turns that key into a tree lookup and a blob read, so the database
 * pointers, the artifact identity, and the pre-render identity do not change.
 *
 * Writers upload every blob first and the tree last. A version without a
 * tree does not exist for readers.
 *
 * See `docs/current/production-docs-content-injection.md`.
 */

export const VERSION_TREE_FILE_NAME = "tree.json";
export const VERSION_TREE_FORMAT = "doxa-version-tree";
export const VERSION_TREE_FORMAT_VERSION = 1;
export const SUPPORTED_VERSION_TREE_FORMAT_VERSIONS = [1] as const;
export const VERSION_TREE_MAX_FILES = 20_000;
export const VERSION_TREE_CONTENT_TYPE = "application/json; charset=utf-8";

const DEFAULT_TREE_CACHE_ENTRIES = 128;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const VERSION_KEY = /^sites\/([^/]+)\/versions\/([^/]+)\/(.*)$/;

export type VersionTreeErrorCode =
  | "tree_invalid"
  | "blob_missing"
  | "unsafe_path"
  | "unsafe_segment"
  | "path_missing"
  | "already_committed";

export class VersionTreeError extends Error {
  constructor(
    readonly code: VersionTreeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VersionTreeError";
  }
}

/** A relative artifact path such as `source/guide/index.mdx`. */
export function isSafeVersionTreePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.length > 512 ||
    path === VERSION_TREE_FILE_NAME ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    return false;
  }

  return path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export const versionTreePathSchema = z
  .string()
  .refine(isSafeVersionTreePath, "Expected a safe relative artifact path");

export const versionTreeEntrySchema = z
  .object({
    sha256: z.string().regex(SHA256_HEX),
    size: z.number().int().nonnegative(),
    contentType: z.string().min(1).max(200),
  })
  .strict();

const versionTreeSegmentSchema = z.string().regex(SAFE_SEGMENT);

export const versionTreeSchema = z
  .object({
    format: z.literal(VERSION_TREE_FORMAT),
    formatVersion: z.literal(VERSION_TREE_FORMAT_VERSION),
    siteId: versionTreeSegmentSchema,
    versionId: versionTreeSegmentSchema,
    files: z
      .record(versionTreePathSchema, versionTreeEntrySchema)
      .refine(
        (files) => Object.keys(files).length <= VERSION_TREE_MAX_FILES,
        "The version tree has too many files",
      ),
  })
  .strict();

export type VersionTreeEntry = z.infer<typeof versionTreeEntrySchema>;
export type VersionTree = z.infer<typeof versionTreeSchema>;

export interface VersionPrefixParts {
  siteId: string;
  versionId: string;
  prefix: string;
}

export interface VersionArtifactKeyParts extends VersionPrefixParts {
  /** The relative artifact path. Empty for the folder itself. */
  path: string;
}

/**
 * Splits `sites/{siteId}/versions/{versionId}/{path}`. Returns null for every
 * key outside a version folder, for example site assets or generation state.
 */
export function parseVersionArtifactKey(
  key: string,
): VersionArtifactKeyParts | null {
  const match = VERSION_KEY.exec(key);

  if (!match) {
    return null;
  }

  const [, siteId, versionId, path] = match;

  if (!SAFE_SEGMENT.test(siteId) || !SAFE_SEGMENT.test(versionId)) {
    throw new VersionTreeError(
      "unsafe_segment",
      `Unsafe version artifact key: ${key}`,
    );
  }

  return {
    siteId,
    versionId,
    prefix: `sites/${siteId}/versions/${versionId}`,
    path,
  };
}

export function parseVersionPrefix(prefix: string): VersionPrefixParts | null {
  const parsed = parseVersionArtifactKey(`${prefix.replace(/\/+$/, "")}/`);
  return parsed && parsed.path === ""
    ? {
        siteId: parsed.siteId,
        versionId: parsed.versionId,
        prefix: parsed.prefix,
      }
    : null;
}

export function versionTreeKey(prefix: string): string {
  return `${prefix}/${VERSION_TREE_FILE_NAME}`;
}

export function siteBlobPrefix(siteId: string): string {
  assertSafeSegment(siteId);
  return `sites/${siteId}/blobs/`;
}

export function siteBlobKey(siteId: string, sha256: string): string {
  if (!SHA256_HEX.test(sha256)) {
    throw new VersionTreeError("tree_invalid", `Invalid blob hash: ${sha256}`);
  }

  return `${siteBlobPrefix(siteId)}${sha256}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function toVersionTreeBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string"
    ? new TextEncoder().encode(content)
    : content;
}

/** Parses stored tree text and checks that it belongs to its folder. */
export function parseVersionTreeText(
  text: string,
  expected: Pick<VersionPrefixParts, "siteId" | "versionId">,
): VersionTree {
  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    throw new VersionTreeError("tree_invalid", "The version tree is not JSON.");
  }

  const parsed = versionTreeSchema.safeParse(raw);

  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? "unknown";
    throw new VersionTreeError(
      "tree_invalid",
      `The version tree is invalid: ${reason}`,
    );
  }

  if (
    parsed.data.siteId !== expected.siteId ||
    parsed.data.versionId !== expected.versionId
  ) {
    throw new VersionTreeError(
      "tree_invalid",
      "The version tree belongs to another folder.",
    );
  }

  return parsed.data;
}

/** Stable JSON: sorted paths, so the same tree always has the same bytes. */
export function serializeVersionTree(tree: VersionTree): string {
  const files = Object.fromEntries(
    Object.keys(tree.files)
      .sort()
      .map((path) => [path, tree.files[path]]),
  );

  return `${JSON.stringify({ ...tree, files }, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Storage boundary

export interface VersionTreeObject {
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  size?: number;
  httpMetadata?: { contentType?: string };
}

/** The subset of `R2Bucket` that this module uses. */
export interface VersionTreeStorage {
  get(key: string): Promise<VersionTreeObject | null>;
  head(key: string): Promise<unknown | null>;
  put(
    key: string,
    value: string | Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Tree cache

/**
 * Trees never change after their commit, so a parsed tree can stay in memory
 * for the life of the isolate. A missing tree is never kept: a publish can
 * create it a moment later.
 */
export class VersionTreeCache {
  private readonly trees = new Map<string, Promise<VersionTree | null>>();

  constructor(private readonly maxEntries = DEFAULT_TREE_CACHE_ENTRIES) {}

  load(
    prefix: string,
    read: () => Promise<VersionTree | null>,
  ): Promise<VersionTree | null> {
    const cached = this.trees.get(prefix);

    if (cached) {
      this.trees.delete(prefix);
      this.trees.set(prefix, cached);
      return cached;
    }

    const pending = read();
    this.trees.set(prefix, pending);
    pending.then(
      (tree) => {
        if (tree === null && this.trees.get(prefix) === pending) {
          this.trees.delete(prefix);
        }
      },
      () => {
        if (this.trees.get(prefix) === pending) this.trees.delete(prefix);
      },
    );

    while (this.trees.size > this.maxEntries) {
      const oldest = this.trees.keys().next().value;
      if (oldest === undefined) break;
      this.trees.delete(oldest);
    }

    return pending;
  }

  clear(): void {
    this.trees.clear();
  }
}

const sharedTreeCaches = new WeakMap<object, VersionTreeCache>();

/** One cache per storage binding and isolate. */
export function sharedVersionTreeCache(storage: object): VersionTreeCache {
  let cache = sharedTreeCaches.get(storage);

  if (!cache) {
    cache = new VersionTreeCache();
    sharedTreeCaches.set(storage, cache);
  }

  return cache;
}

// ---------------------------------------------------------------------------
// Blob cache

const DEFAULT_BLOB_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_BLOB_CACHE_MAX_BLOB_BYTES = 256 * 1024;

/**
 * Keeps the bytes of immutable storage objects by key: blobs and trees.
 *
 * - A blob key is the SHA-256 hash of the blob's bytes, so a key always names
 *   the same bytes and a cached blob never goes stale.
 * - A tree never changes after its commit, and a version id is never reused.
 *
 * The reader keeps only objects that storage returned: a missing object is
 * never kept, so the reader still fails closed on it. A cache can fail. The
 * reader treats a failed `get` as a miss and ignores a failed `put`.
 */
export interface VersionByteCache {
  /** The largest entry, in bytes, that the cache keeps. */
  readonly maxEntryBytes: number;
  /** The bytes of a key, or null when the cache does not hold it. */
  get(key: string): Promise<Uint8Array | null> | Uint8Array | null;
  put(key: string, bytes: Uint8Array): Promise<void> | void;
}

/**
 * An in-memory byte cache with a total size cap. When a new entry does not
 * fit, the least recently used entries go first.
 */
export class MemoryVersionByteCache implements VersionByteCache {
  readonly maxEntryBytes: number;
  private readonly maxBytes: number;
  private readonly entries = new Map<string, Uint8Array>();
  private bytes = 0;

  constructor(
    options: { maxBytes?: number; maxEntryBytes?: number } = {},
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_BLOB_CACHE_MAX_BYTES;
    this.maxEntryBytes = Math.min(
      options.maxEntryBytes ?? DEFAULT_BLOB_CACHE_MAX_BLOB_BYTES,
      this.maxBytes,
    );
  }

  /** The total bytes of the entries in the cache. */
  get size(): number {
    return this.bytes;
  }

  get(key: string): Uint8Array | null {
    const cached = this.entries.get(key);

    if (!cached) {
      return null;
    }

    this.entries.delete(key);
    this.entries.set(key, cached);
    return cached;
  }

  put(key: string, bytes: Uint8Array): void {
    if (bytes.byteLength > this.maxEntryBytes) {
      return;
    }

    this.delete(key);
    this.entries.set(key, bytes);
    this.bytes += bytes.byteLength;

    while (this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  private delete(key: string): void {
    const existing = this.entries.get(key);

    if (existing) {
      this.entries.delete(key);
      this.bytes -= existing.byteLength;
    }
  }
}

const sharedBlobCaches = new WeakMap<object, MemoryVersionByteCache>();

/** One in-memory blob cache per storage binding and isolate. */
export function sharedVersionBlobCache(
  storage: object,
): MemoryVersionByteCache {
  let cache = sharedBlobCaches.get(storage);

  if (!cache) {
    cache = new MemoryVersionByteCache();
    sharedBlobCaches.set(storage, cache);
  }

  return cache;
}

/**
 * Reads the first cache, then the next one. A hit in a later cache fills the
 * earlier caches. A put goes to every cache. Each cache keeps its own size
 * limit; the chain accepts the largest entry that any of its caches accepts.
 */
export function chainVersionByteCaches(
  ...caches: readonly VersionByteCache[]
): VersionByteCache {
  return {
    maxEntryBytes: Math.max(0, ...caches.map((cache) => cache.maxEntryBytes)),

    async get(key) {
      for (const [index, cache] of caches.entries()) {
        const bytes = await readByteCache(cache, key);

        if (bytes) {
          for (const earlier of caches.slice(0, index)) {
            writeByteCache(earlier, key, bytes);
          }
          return bytes;
        }
      }

      return null;
    },

    put(key, bytes) {
      for (const cache of caches) {
        writeByteCache(cache, key, bytes);
      }
    },
  };
}

async function readByteCache(
  cache: VersionByteCache,
  key: string,
): Promise<Uint8Array | null> {
  try {
    return await cache.get(key);
  } catch {
    return null;
  }
}

function writeByteCache(
  cache: VersionByteCache,
  key: string,
  bytes: Uint8Array,
): void {
  if (bytes.byteLength > cache.maxEntryBytes) {
    return;
  }

  try {
    const pending = cache.put(key, bytes);
    if (pending) pending.catch(() => undefined);
  } catch {
    // A cache is only a shortcut. The read already has its bytes.
  }
}

function blobObject(
  bytes: Uint8Array,
  entry: VersionTreeEntry,
): VersionTreeObject {
  return {
    text: async () => new TextDecoder().decode(bytes),
    // A copy, so a caller can never change the cached bytes.
    arrayBuffer: async () => bytes.slice().buffer,
    size: entry.size,
    httpMetadata: { contentType: entry.contentType },
  };
}

// ---------------------------------------------------------------------------
// Reader

export interface VersionTreeReaderOptions {
  cache?: VersionTreeCache;
  /**
   * Keeps the bytes of small blobs, so a repeated read of the same content
   * makes no storage call. Without it, every blob read goes to storage.
   */
  blobCache?: VersionByteCache;
  /**
   * Keeps the bytes of trees, below `cache`. A tree cache that outlives the
   * isolate, such as the Workers cache of a data center, saves the tree read
   * of every new isolate.
   */
  treeBytesCache?: VersionByteCache;
}

export interface VersionTreeReader {
  /**
   * Reads a logical key. A version key resolves through its tree. Any other
   * key goes to storage unchanged.
   */
  get(key: string): Promise<VersionTreeObject | null>;
  /** The tree of one version folder, or null when the folder has no tree. */
  readTree(prefix: string): Promise<VersionTree | null>;
  /**
   * The logical keys under a version-scoped prefix, for example
   * `sites/a/versions/b/source/`. Returns null when the version has no tree.
   */
  listVersionKeys(prefix: string): Promise<string[] | null>;
}

export function createVersionTreeReader(
  storage: Pick<VersionTreeStorage, "get">,
  options: VersionTreeReaderOptions = {},
): VersionTreeReader {
  const cache = options.cache ?? new VersionTreeCache();
  const blobCache = options.blobCache;
  const treeBytesCache = options.treeBytesCache;

  const loadTree = async (
    parts: VersionPrefixParts,
  ): Promise<VersionTree | null> => {
    const key = versionTreeKey(parts.prefix);
    const cached = treeBytesCache
      ? await readByteCache(treeBytesCache, key)
      : null;

    if (cached) {
      try {
        return parseVersionTreeText(new TextDecoder().decode(cached), parts);
      } catch {
        // A damaged entry is a miss. Storage holds the real tree.
      }
    }

    const object = await storage.get(key);

    if (!object) {
      return null;
    }

    const text = await object.text();
    const tree = parseVersionTreeText(text, parts);

    if (treeBytesCache) {
      writeByteCache(treeBytesCache, key, new TextEncoder().encode(text));
    }

    return tree;
  };

  const readTree = (prefix: string): Promise<VersionTree | null> => {
    const parts = parseVersionPrefix(prefix);

    if (!parts) {
      throw new VersionTreeError(
        "unsafe_path",
        `Not a version folder: ${prefix}`,
      );
    }

    return cache.load(parts.prefix, () => loadTree(parts));
  };

  return {
    readTree,

    async get(key) {
      const parts = parseVersionArtifactKey(key);

      if (!parts) {
        return storage.get(key);
      }

      if (!isSafeVersionTreePath(parts.path)) {
        return null;
      }

      const tree = await readTree(parts.prefix);

      if (!tree) {
        return null;
      }

      const entry = tree.files[parts.path];

      if (!entry) {
        return null;
      }

      const blobKey = siteBlobKey(parts.siteId, entry.sha256);
      const missing = () =>
        new VersionTreeError(
          "blob_missing",
          `The blob of ${parts.path} in ${parts.prefix} is missing.`,
        );

      if (blobCache && entry.size <= blobCache.maxEntryBytes) {
        const cached = await readByteCache(blobCache, blobKey);

        // The size check keeps a damaged cache entry from being served.
        if (cached && cached.byteLength === entry.size) {
          return blobObject(cached, entry);
        }

        const stored = await storage.get(blobKey);

        if (!stored) {
          throw missing();
        }

        const bytes = new Uint8Array(await stored.arrayBuffer());
        writeByteCache(blobCache, blobKey, bytes);
        return blobObject(bytes, entry);
      }

      const blob = await storage.get(blobKey);

      if (!blob) {
        throw missing();
      }

      return {
        text: () => blob.text(),
        arrayBuffer: () => blob.arrayBuffer(),
        size: entry.size,
        httpMetadata: { contentType: entry.contentType },
      };
    },

    async listVersionKeys(prefix) {
      const parts = parseVersionArtifactKey(prefix);

      if (!parts) {
        throw new VersionTreeError(
          "unsafe_path",
          `Not a version-scoped prefix: ${prefix}`,
        );
      }

      const tree = await readTree(parts.prefix);

      if (!tree) {
        return null;
      }

      return Object.keys(tree.files)
        .filter((path) => path.startsWith(parts.path))
        .sort()
        .map((path) => `${parts.prefix}/${path}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Writer

export interface VersionTreeCommit {
  artifactPrefix: string;
  manifestPath: string;
  tree: VersionTree;
}

/**
 * Builds one immutable version.
 *
 * `put` uploads a blob only when no known tree already holds its hash. The
 * base tree of a publish is a production version or a branch base, and the
 * garbage collector keeps the blobs of those trees. `commit` writes the tree
 * last and closes the writer.
 *
 * A blob sweep can delete an old unreferenced blob at the moment this writer
 * uploads the same bytes again. After the tree exists, the sweep keeps the
 * blob. So `commit` checks every blob that it uploaded and uploads a missing
 * one again.
 */
export class VersionTreeWriter {
  readonly artifactPrefix: string;
  private readonly files = new Map<string, VersionTreeEntry>();
  private readonly knownBlobs = new Set<string>();
  private readonly uploads = new Map<
    string,
    { done: Promise<void>; bytes: Uint8Array; contentType: string }
  >();
  private committed = false;

  constructor(
    private readonly storage: Pick<VersionTreeStorage, "put" | "head">,
    readonly input: {
      siteId: string;
      versionId: string;
      /** A tree of the same site. Its blobs are known to exist. */
      base?: VersionTree | null;
    },
  ) {
    assertSafeSegment(input.siteId);
    assertSafeSegment(input.versionId);
    this.artifactPrefix = `sites/${input.siteId}/versions/${input.versionId}`;

    if (input.base) {
      this.assertSameSite(input.base);
      for (const entry of Object.values(input.base.files)) {
        this.knownBlobs.add(entry.sha256);
      }
    }
  }

  /** The number of distinct blobs that this writer uploaded. */
  get uploadedBlobCount(): number {
    return this.uploads.size;
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  async put(
    path: string,
    content: string | Uint8Array,
    contentType: string,
  ): Promise<VersionTreeEntry> {
    this.assertOpen();
    assertSafePath(path);

    const bytes = toVersionTreeBytes(content);
    const entry: VersionTreeEntry = {
      sha256: await sha256Hex(bytes),
      size: bytes.byteLength,
      contentType,
    };

    if (!this.knownBlobs.has(entry.sha256)) {
      let upload = this.uploads.get(entry.sha256);

      if (!upload) {
        upload = {
          done: this.uploadBlob(entry.sha256, bytes, contentType),
          bytes,
          contentType,
        };
        this.uploads.set(entry.sha256, upload);
      }

      await upload.done;
    }

    this.files.set(path, entry);
    return entry;
  }

  /** Reuses the entry of `path` from the base tree without any read. */
  copy(
    path: string,
    from: VersionTree | null | undefined = this.input.base,
  ): VersionTreeEntry {
    this.assertOpen();
    assertSafePath(path);

    if (!from) {
      throw new VersionTreeError(
        "path_missing",
        "The writer has no base tree.",
      );
    }

    this.assertSameSite(from);
    const entry = from.files[path];

    if (!entry) {
      throw new VersionTreeError(
        "path_missing",
        `The base tree has no ${path}.`,
      );
    }

    this.knownBlobs.add(entry.sha256);
    this.files.set(path, entry);
    return entry;
  }

  delete(path: string): void {
    this.assertOpen();
    this.files.delete(path);
  }

  async commit(): Promise<VersionTreeCommit> {
    this.assertOpen();
    await Promise.all([...this.uploads.values()].map(({ done }) => done));

    const tree = versionTreeSchema.parse({
      format: VERSION_TREE_FORMAT,
      formatVersion: VERSION_TREE_FORMAT_VERSION,
      siteId: this.input.siteId,
      versionId: this.input.versionId,
      files: Object.fromEntries(
        this.paths().map((path) => [path, this.files.get(path)]),
      ),
    });

    await this.storage.put(
      versionTreeKey(this.artifactPrefix),
      serializeVersionTree(tree),
      { httpMetadata: { contentType: VERSION_TREE_CONTENT_TYPE } },
    );
    this.committed = true;

    await Promise.all(
      [...this.uploads].map(async ([sha256, upload]) => {
        const key = siteBlobKey(this.input.siteId, sha256);

        if ((await this.storage.head(key)) === null) {
          await this.uploadBlob(sha256, upload.bytes, upload.contentType);
        }
      }),
    );

    return {
      artifactPrefix: this.artifactPrefix,
      manifestPath: `${this.artifactPrefix}/manifest.json`,
      tree,
    };
  }

  private async uploadBlob(
    sha256: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.storage.put(siteBlobKey(this.input.siteId, sha256), bytes, {
      httpMetadata: { contentType },
    });
  }

  private assertOpen(): void {
    if (this.committed) {
      throw new VersionTreeError(
        "already_committed",
        "The version tree is already committed.",
      );
    }
  }

  private assertSameSite(tree: VersionTree): void {
    if (tree.siteId !== this.input.siteId) {
      throw new VersionTreeError(
        "tree_invalid",
        "A version can only reuse blobs of its own site.",
      );
    }
  }
}

/** Writes a complete file list as one version, for publications and tests. */
export async function writeVersionTree(
  storage: Pick<VersionTreeStorage, "put" | "head">,
  input: {
    siteId: string;
    versionId: string;
    files: readonly {
      path: string;
      content: string | Uint8Array;
      contentType: string;
    }[];
  },
): Promise<VersionTreeCommit> {
  const writer = new VersionTreeWriter(storage, input);

  for (const file of input.files) {
    await writer.put(file.path, file.content, file.contentType);
  }

  return writer.commit();
}

function assertSafePath(path: string): void {
  if (!isSafeVersionTreePath(path)) {
    throw new VersionTreeError("unsafe_path", `Unsafe artifact path: ${path}`);
  }
}

function assertSafeSegment(segment: string): void {
  if (!SAFE_SEGMENT.test(segment)) {
    throw new VersionTreeError(
      "unsafe_segment",
      `Unsafe storage segment: ${segment}`,
    );
  }
}
