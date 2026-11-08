/**
 * A small in-memory `R2Bucket` for storage-level tests. It records every call,
 * so a test can count reads and writes like the real bucket bills them.
 */
export interface MemoryR2Object {
  bytes: Uint8Array;
  contentType?: string;
  uploaded: Date;
  /** Changes on every write, like an R2 ETag. */
  etag: string;
}

export function createMemoryR2Bucket(options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const objects = new Map<string, MemoryR2Object>();
  let writes = 0;
  const calls = {
    get: [] as string[],
    head: [] as string[],
    put: [] as string[],
    delete: [] as string[],
    list: [] as string[],
  };

  const bodyOf = (key: string, object: MemoryR2Object) => ({
    key,
    size: object.bytes.byteLength,
    uploaded: object.uploaded,
    etag: object.etag,
    httpMetadata: { contentType: object.contentType },
    text: async () => new TextDecoder().decode(object.bytes),
    arrayBuffer: async () => object.bytes.slice().buffer,
    get body() {
      return new Response(object.bytes.slice()).body;
    },
  });

  const bucket = {
    async get(key: string) {
      calls.get.push(key);
      const object = objects.get(key);
      return object ? bodyOf(key, object) : null;
    },
    async head(key: string) {
      calls.head.push(key);
      const object = objects.get(key);
      return object
        ? { key, size: object.bytes.byteLength, uploaded: object.uploaded }
        : null;
    },
    async put(
      key: string,
      value: string | Uint8Array | ArrayBuffer,
      putOptions?: {
        httpMetadata?: { contentType?: string };
        onlyIf?: { etagMatches?: string } | Headers;
      },
    ) {
      calls.put.push(key);
      // Like R2: a failed condition stores nothing and returns null.
      if (!conditionHolds(putOptions?.onlyIf, objects.get(key))) return null;
      const bytes =
        typeof value === "string"
          ? new TextEncoder().encode(value)
          : value instanceof Uint8Array
            ? value.slice()
            : new Uint8Array(value);
      objects.set(key, {
        bytes,
        contentType: putOptions?.httpMetadata?.contentType,
        uploaded: now(),
        etag: `etag-${++writes}`,
      });
      return { key };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        calls.delete.push(key);
        objects.delete(key);
      }
    },
    async list(listOptions: { prefix?: string; limit?: number; cursor?: string }) {
      const prefix = listOptions.prefix ?? "";
      calls.list.push(prefix);
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort();
      const start = listOptions.cursor ? Number(listOptions.cursor) : 0;
      const limit = listOptions.limit ?? 1000;
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return {
        objects: page.map((key) => {
          const object = objects.get(key)!;
          return { key, size: object.bytes.byteLength, uploaded: object.uploaded };
        }),
        truncated,
        ...(truncated ? { cursor: String(start + limit) } : {}),
        delimitedPrefixes: [],
      };
    },
  };

  const text = (key: string): string | null => {
    const object = objects.get(key);
    return object ? new TextDecoder().decode(object.bytes) : null;
  };

  const resetCalls = () => {
    for (const list of Object.values(calls)) list.length = 0;
  };

  return {
    bucket: bucket as unknown as R2Bucket,
    objects,
    calls,
    text,
    resetCalls,
  };
}

/**
 * The two conditions that the stores use: `etagMatches`, and the
 * `If-None-Match: *` header that passes only when no object exists.
 */
function conditionHolds(
  condition: { etagMatches?: string } | Headers | undefined,
  current: MemoryR2Object | undefined,
): boolean {
  if (condition === undefined) return true;
  if (condition instanceof Headers) {
    const noneMatch = condition.get("if-none-match");
    if (noneMatch !== "*" || [...condition.keys()].length !== 1) {
      throw new Error("The memory bucket supports only If-None-Match: *.");
    }
    return current === undefined;
  }
  return condition.etagMatches === undefined || current?.etag === condition.etagMatches;
}
