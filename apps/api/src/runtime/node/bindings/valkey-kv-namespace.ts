import type { ReadableStream as WorkersReadableStream } from "@cloudflare/workers-types";
import type { Redis } from "ioredis";

const DEFAULT_LIST_LIMIT = 1000;
/** Bytes above every UTF-8 lead byte, so `prefix + LEX_MAX` ends a prefix range. */
const LEX_MAX = Buffer.from([0xff]);

type ValueType = "text" | "json" | "arrayBuffer" | "stream";
/** `put` values. Streams come typed from the Workers types or the Node globals, depending on the caller. */
type PutValue = string | ArrayBuffer | ArrayBufferView | ReadableStream | WorkersReadableStream;
type GetTypeOrOptions = ValueType | Partial<KVNamespaceGetOptions<ValueType | undefined>> | undefined;

/** What one key stores in Valkey: the value, its metadata and its expiry. */
interface StoredEntry {
  /** The value, as text or as base64 for bytes. */
  v: string;
  /** True when `v` is base64. */
  b: boolean;
  m: unknown;
  /** Expiry in seconds since the epoch, as Workers KV reports it. */
  e: number | null;
}

/** Namespace names go into a hash tag, so they must not hold braces. */
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * A Workers KV namespace on Valkey, for the Node server. One namespace owns
 * the keys `kv:{<namespace>}:*` and the sorted set `kv-index:{<namespace>}`,
 * which keeps the key names in order so `list` can page by prefix and
 * cursor as Workers KV does. An expired key leaves the index on the next
 * `list` that meets it.
 *
 * `{<namespace>}` is a hash tag: Valkey in cluster mode (ElastiCache
 * Serverless) puts every key of the namespace in one slot. Without it, the
 * MULTI of `put` and `delete` and the MGET of `get` and `list` fail with
 * CROSSSLOT.
 *
 * The `get` overloads of `KVNamespace` return the type that the caller asks
 * for (`"json"` returns the parsed value). One generic signature covers
 * them: KV values are untyped at run time, in Workers too.
 */
export class ValkeyKvNamespace implements KVNamespace {
  private readonly keyPrefix: string;
  private readonly indexKey: string;

  constructor(
    private readonly valkey: Redis,
    namespace: string,
  ) {
    if (!NAMESPACE_PATTERN.test(namespace)) {
      throw new Error(`KV namespace "${namespace}" must be lowercase letters, digits and dashes.`);
    }
    this.keyPrefix = `kv:{${namespace}}:`;
    this.indexKey = `kv-index:{${namespace}}`;
  }

  get<Result = unknown>(key: string | string[], typeOrOptions?: GetTypeOrOptions): Promise<Result>;
  async get(key: string | string[], typeOrOptions?: GetTypeOrOptions): Promise<unknown> {
    const type = valueTypeOf(typeOrOptions);
    if (Array.isArray(key)) {
      const entries = await this.readEntries(key);
      return new Map(key.map((name, index) => [name, decodeValue(entries[index] ?? null, type)]));
    }
    return decodeValue(await this.readEntry(key), type);
  }

  getWithMetadata<Result = unknown>(key: string | string[], typeOrOptions?: GetTypeOrOptions): Promise<Result>;
  async getWithMetadata(key: string | string[], typeOrOptions?: GetTypeOrOptions): Promise<unknown> {
    const type = valueTypeOf(typeOrOptions);
    if (Array.isArray(key)) {
      const entries = await this.readEntries(key);
      return new Map(key.map((name, index) => [name, withMetadata(entries[index] ?? null, type)]));
    }
    return withMetadata(await this.readEntry(key), type);
  }

  async put(key: string, value: PutValue, options?: KVNamespacePutOptions): Promise<void> {
    const expiresAt = expiryOf(options);
    const entry = await toStoredEntry(value, options?.metadata ?? null, expiresAt);
    const write = this.valkey.multi();
    if (expiresAt === null) write.set(this.storageKey(key), JSON.stringify(entry));
    else write.set(this.storageKey(key), JSON.stringify(entry), "EXAT", expiresAt);
    write.zadd(this.indexKey, 0, key);
    await execOrThrow(write.exec());
  }

  async delete(key: string): Promise<void> {
    await execOrThrow(this.valkey.multi().del(this.storageKey(key)).zrem(this.indexKey, key).exec());
  }

  async list<Metadata = unknown>(options?: KVNamespaceListOptions): Promise<KVNamespaceListResult<Metadata>> {
    const limit = options?.limit ?? DEFAULT_LIST_LIMIT;
    const prefix = options?.prefix ?? "";
    const keys: KVNamespaceListKey<Metadata>[] = [];
    let after = options?.cursor ?? null;

    while (keys.length < limit) {
      const names = await this.indexRange(prefix, after, limit - keys.length + 1);
      const page = names.slice(0, limit - keys.length);
      const entries = await this.readEntries(page);
      const expired: string[] = [];
      page.forEach((name, index) => {
        const entry = entries[index];
        if (!entry) {
          expired.push(name);
          return;
        }
        keys.push(listKeyOf<Metadata>(name, entry));
      });
      if (expired.length > 0) await this.valkey.zrem(this.indexKey, ...expired);

      const more = names.length > page.length;
      after = page.at(-1) ?? after;
      if (!more) return { list_complete: true, keys, cacheStatus: null };
    }

    // `after` is set: the loop read at least one page to fill `keys`.
    return { list_complete: false, keys, cursor: after ?? "", cacheStatus: null };
  }

  private storageKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  /** Key names after `after` (or from `prefix`), in byte order, at most `count`. */
  private indexRange(prefix: string, after: string | null, count: number): Promise<string[]> {
    const min = after === null ? (prefix ? `[${prefix}` : "-") : `(${after}`;
    const max = prefix ? Buffer.concat([Buffer.from(`(${prefix}`), LEX_MAX]) : "+";
    return this.valkey.zrangebylex(this.indexKey, min, max, "LIMIT", 0, count);
  }

  private async readEntry(key: string): Promise<StoredEntry | null> {
    return parseEntry(await this.valkey.get(this.storageKey(key)));
  }

  private async readEntries(keys: readonly string[]): Promise<(StoredEntry | null)[]> {
    if (keys.length === 0) return [];
    const raw = await this.valkey.mget(...keys.map((key) => this.storageKey(key)));
    return raw.map(parseEntry);
  }
}

function valueTypeOf(typeOrOptions: GetTypeOrOptions): ValueType {
  if (typeof typeOrOptions === "string") return typeOrOptions;
  return typeOrOptions?.type ?? "text";
}

function expiryOf(options: KVNamespacePutOptions | undefined): number | null {
  if (options?.expiration !== undefined) return Math.floor(options.expiration);
  if (options?.expirationTtl !== undefined) {
    if (options.expirationTtl <= 0) throw new Error("expirationTtl must be a positive number of seconds.");
    return Math.floor(Date.now() / 1000) + Math.ceil(options.expirationTtl);
  }
  return null;
}

async function toStoredEntry(value: PutValue, metadata: unknown, expiresAt: number | null): Promise<StoredEntry> {
  if (typeof value === "string") return { v: value, b: false, m: metadata, e: expiresAt };
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : await readAllBytes(value);
  return { v: Buffer.from(bytes).toString("base64"), b: true, m: metadata, e: expiresAt };
}

interface ByteStream {
  getReader(): { read(): Promise<{ done: boolean; value?: unknown }> };
}

async function readAllBytes(stream: ByteStream): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) throw new TypeError("A KV stream value must yield bytes.");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function parseEntry(raw: string | null): StoredEntry | null {
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "v" in parsed &&
    typeof parsed.v === "string" &&
    "b" in parsed &&
    typeof parsed.b === "boolean"
  ) {
    const expiry = "e" in parsed && typeof parsed.e === "number" ? parsed.e : null;
    return { v: parsed.v, b: parsed.b, m: "m" in parsed ? parsed.m : null, e: expiry };
  }
  throw new Error("A KV entry in Valkey has an unknown shape.");
}

function decodeValue(entry: StoredEntry | null, type: ValueType): unknown {
  if (!entry) return null;
  const bytes = () => (entry.b ? Buffer.from(entry.v, "base64") : Buffer.from(entry.v, "utf8"));
  switch (type) {
    case "text":
      return entry.b ? bytes().toString("utf8") : entry.v;
    case "json":
      return JSON.parse(entry.b ? bytes().toString("utf8") : entry.v);
    case "arrayBuffer":
      return new Uint8Array(bytes()).buffer;
    case "stream": {
      const chunk = new Uint8Array(bytes());
      return new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      });
    }
  }
}

function withMetadata(entry: StoredEntry | null, type: ValueType): KVNamespaceGetWithMetadataResult<unknown, unknown> {
  return { value: decodeValue(entry, type), metadata: entry?.m ?? null, cacheStatus: null };
}

function listKeyOf<Metadata>(name: string, entry: StoredEntry): KVNamespaceListKey<Metadata> {
  return {
    name,
    ...(entry.e !== null ? { expiration: entry.e } : {}),
    ...(entry.m !== null && entry.m !== undefined ? { metadata: metadataOf<Metadata>(entry.m) } : {}),
  };
}

/** Metadata is stored as the caller gave it, and read back with the caller's type, as in Workers KV. */
function metadataOf<Metadata>(value: unknown): Metadata;
function metadataOf(value: unknown): unknown {
  return value;
}

async function execOrThrow(pending: Promise<[error: Error | null, result: unknown][] | null>): Promise<void> {
  const results = await pending;
  if (results === null) throw new Error("A Valkey transaction was aborted.");
  const failed = results.find(([error]) => error !== null);
  if (failed?.[0]) throw failed[0];
}
