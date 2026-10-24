interface MemoryKvEntry {
  value: string;
  metadata?: unknown;
}

interface PutOptions {
  metadata?: unknown;
}

interface ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

/**
 * An in-memory `KVNamespace` with the calls the OAuth provider and our stores
 * make: text and JSON reads, puts with metadata, deletes, and paged lists.
 * Expiry is not modelled; tests that need it control time instead.
 */
export function createMemoryKv() {
  const entries = new Map<string, MemoryKvEntry>();

  const kv = {
    async get(key: string, options?: "text" | "json" | { type?: string }) {
      const entry = entries.get(key);
      if (!entry) return null;
      const type = typeof options === "string" ? options : options?.type;
      return type === "json" ? JSON.parse(entry.value) : entry.value;
    },
    async put(key: string, value: string, options?: PutOptions) {
      entries.set(key, { value, metadata: options?.metadata });
    },
    async delete(key: string) {
      entries.delete(key);
    },
    async list(options: ListOptions = {}) {
      const names = [...entries.keys()]
        .filter((name) => name.startsWith(options.prefix ?? ""))
        .sort();
      const start = options.cursor ? Number(options.cursor) : 0;
      const limit = options.limit ?? 1000;
      const page = names.slice(start, start + limit);
      const next = start + page.length;
      const listComplete = next >= names.length;
      return {
        keys: page.map((name) => ({ name, metadata: entries.get(name)?.metadata })),
        list_complete: listComplete,
        cursor: listComplete ? undefined : String(next),
      };
    },
  };

  return {
    // The one cast: KVNamespace has many overloads this fake does not need.
    kv: kv as unknown as KVNamespace,
    entries,
  };
}
