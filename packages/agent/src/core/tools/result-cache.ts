import { createHash } from "node:crypto";

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_ENTRY_CHARS = 64_000;

export interface ToolResultCache {
  /** Returns cached output or runs `compute` and stores its output. */
  resolve(
    toolName: string,
    args: unknown,
    compute: () => Promise<string>,
  ): Promise<string>;
  readonly hits: number;
  readonly misses: number;
}

export interface ToolResultCacheOptions {
  maxEntries?: number;
  maxEntryChars?: number;
}

export function createToolResultCache(
  options: ToolResultCacheOptions = {},
): ToolResultCache {
  const maxEntries = positiveInteger(
    options.maxEntries,
    DEFAULT_MAX_ENTRIES,
  );
  const maxEntryChars = positiveInteger(
    options.maxEntryChars,
    DEFAULT_MAX_ENTRY_CHARS,
  );
  const entries = new Map<string, string>();
  const inFlight = new Map<string, Promise<string>>();
  let hits = 0;
  let misses = 0;

  return {
    get hits() {
      return hits;
    },
    get misses() {
      return misses;
    },
    async resolve(toolName, args, compute) {
      const key = cacheKey(toolName, args);
      const cached = entries.get(key);
      if (cached !== undefined) {
        hits += 1;
        refreshLruEntry(entries, key, cached);
        return cached;
      }

      const pending = inFlight.get(key);
      if (pending) {
        hits += 1;
        return pending;
      }

      misses += 1;
      const computation = compute().then((output) => {
        if (output.length <= maxEntryChars) {
          entries.set(key, output);
          evictOldestEntries(entries, maxEntries);
        }
        return output;
      }).finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, computation);
      return computation;
    },
  };
}

function cacheKey(toolName: string, args: unknown): string {
  return createHash("sha256")
    .update(toolName)
    .update("\0")
    .update(canonicalJson(args))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(sortJsonValue(value));
  return serialized ?? "null";
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, sortJsonValue(nestedValue)]),
    );
  }
  return value;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError("Tool result cache limits must be positive numbers.");
  }
  return Math.floor(value);
}

function refreshLruEntry(
  entries: Map<string, string>,
  key: string,
  value: string,
): void {
  entries.delete(key);
  entries.set(key, value);
}

function evictOldestEntries(
  entries: Map<string, string>,
  maxEntries: number,
): void {
  while (entries.size > maxEntries) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey === undefined) return;
    entries.delete(oldestKey);
  }
}
