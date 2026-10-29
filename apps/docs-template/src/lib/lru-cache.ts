/**
 * A map that keeps at most `maxEntries` values and drops the least recently
 * used one first. One renderer isolate serves many sites, so a cache keyed by
 * customer input must stay bounded.
 */
export interface LruCache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  readonly size: number;
}

export function createLruCache<K, V>(maxEntries: number): LruCache<K, V> {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError("An LRU cache needs at least one entry.");
  }
  const entries = new Map<K, V>();

  return {
    get(key) {
      if (!entries.has(key)) return undefined;
      const value = entries.get(key);
      // Map keeps insertion order: move the entry to the newest end.
      entries.delete(key);
      if (value !== undefined) entries.set(key, value);
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) return;
        entries.delete(oldest.value);
      }
    },
    get size() {
      return entries.size;
    },
  };
}
