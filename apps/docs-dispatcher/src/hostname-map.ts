import type { DocsDomainResolution } from "@doxahq/contracts";
import {
  DOCS_HOSTNAME_MAP_EXPIRATION_SECONDS,
  DOCS_HOSTNAME_MAP_FORMAT,
  docsHostnameMapEntrySchema,
  docsHostnameMapKey,
  docsHostnameMapSyncSchema,
  isStorableHostnameResolution,
  readHostnameMapEntry,
  type DocsHostnameMapEntry,
  type DocsHostnameMapSync,
  type DocsHostnameMapUpdate,
} from "@doxahq/contracts/docs-hostname-map";

/**
 * - `off`: the dispatcher does not read the map.
 * - `shadow`: it reads the map next to `DocsHostCache`, serves the cache's
 *   answer and logs whether the two agree.
 * - `on`: a map hit serves the request; anything else falls back to
 *   `DocsHostCache`.
 */
export type HostnameMapMode = "off" | "shadow" | "on";

export type HostnameMapStatus =
  | "hit"
  | "miss"
  | "invalid"
  | "expired"
  | "error"
  | "unbound";

export type HostnameMapLookup =
  | { status: "hit"; resolution: DocsDomainResolution }
  | { status: Exclude<HostnameMapStatus, "hit"> };

/**
 * - `agree`: the map holds the same public resolution, or nothing for a
 *   hostname that is not public production.
 * - `missing`: the map has no usable entry for a public production hostname.
 * - `disagree`: the map holds another resolution, or one for a hostname
 *   that is no longer public production.
 * - `error`: the map could not be read.
 */
export type HostnameMapAgreement = "agree" | "missing" | "disagree" | "error";

/**
 * Every entry carries its site ID as KV metadata, so a sweep can list the
 * keys of a site without reading each value (F26).
 */
export interface HostnameMapMetadata {
  siteId: string;
}

/** The part of a KV namespace that the map uses. */
export interface HostnameMapStore {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options: { expirationTtl: number; metadata: HostnameMapMetadata },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

/** An unknown value fails closed to `off`. */
export function parseHostnameMapMode(
  value: string | undefined,
  warn: (message: string) => void = console.warn,
): HostnameMapMode {
  if (value === "shadow" || value === "on") return value;
  if (value !== undefined && value !== "off") {
    warn(
      `[doxa-docs-dispatcher] Invalid DOXA_PROD_KV_HOSTNAME_MODE ${JSON.stringify(value)}; the hostname map is off.`,
    );
  }
  return "off";
}

/** Never throws: every failure is a status, and only a hit is usable. */
export async function lookupHostnameMap(
  store: HostnameMapStore | undefined,
  hostname: string,
  now: number,
): Promise<HostnameMapLookup> {
  if (!store) return { status: "unbound" };
  let text: string | null;
  try {
    text = await store.get(docsHostnameMapKey(hostname));
  } catch {
    return { status: "error" };
  }
  if (text === null) return { status: "miss" };
  return readHostnameMapEntry(parseJson(text), hostname, now);
}

/**
 * A hostname whose stored live resolution changed with this sync: a new
 * public production entry, or one whose resolution differs from the stored
 * one. The regional warm job (M28) starts from these.
 */
export interface HostnameMapLiveChange {
  hostname: string;
  resolution: DocsDomainResolution;
  resolvedAt: number;
}

export interface HostnameMapUpdateOptions {
  /**
   * Called after the write, once per hostname whose live resolution changed.
   * Setting it costs one extra map read per stored update.
   */
  onLiveChange?(change: HostnameMapLiveChange): void;
  now?: number;
}

/**
 * Applies updates that the API computed from the database. The input is
 * validated again here, and only a public production resolution of the same
 * hostname is stored; every other update deletes the entry. Returns the
 * validated input.
 */
export async function applyHostnameMapUpdates(
  store: HostnameMapStore,
  input: unknown,
  options: HostnameMapUpdateOptions = {},
): Promise<DocsHostnameMapSync> {
  const sync = docsHostnameMapSyncSchema.parse(input);
  // Every update is tried; one failed write never hides the others (FC-L6).
  const results = await Promise.allSettled(
    sync.updates.map((update) => applyUpdate(store, update, options)),
  );
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length > 0) throw new HostnameMapWriteError(sync, errors);
  return sync;
}

/**
 * Some map writes failed. `sync` is the validated input; the other updates
 * were written and their `onLiveChange` calls were made.
 */
export class HostnameMapWriteError extends AggregateError {
  constructor(
    readonly sync: DocsHostnameMapSync,
    errors: readonly unknown[],
  ) {
    super(errors, `${errors.length} of ${sync.updates.length} hostname map writes failed`);
    this.name = "HostnameMapWriteError";
  }
}

async function applyUpdate(
  store: HostnameMapStore,
  update: DocsHostnameMapUpdate,
  options: HostnameMapUpdateOptions,
): Promise<void> {
  const key = docsHostnameMapKey(update.hostname);
  if (!isStorableHostnameResolution(update.hostname, update.resolution)) {
    return store.delete(key);
  }
  const before = options.onLiveChange
    ? await lookupHostnameMap(store, update.hostname, options.now ?? Date.now())
    : null;
  const entry: DocsHostnameMapEntry = {
    format: DOCS_HOSTNAME_MAP_FORMAT,
    resolvedAt: update.resolvedAt,
    resolution: update.resolution,
  };
  await store.put(key, JSON.stringify(entry), {
    expirationTtl: DOCS_HOSTNAME_MAP_EXPIRATION_SECONDS,
    metadata: { siteId: update.resolution.siteId },
  });
  if (
    options.onLiveChange &&
    (before?.status !== "hit" ||
      !sameResolution(before.resolution, update.resolution))
  ) {
    options.onLiveChange({
      hostname: update.hostname,
      resolution: update.resolution,
      resolvedAt: update.resolvedAt,
    });
  }
}

export type HostnameMapEntryLookup =
  | { status: "hit"; entry: DocsHostnameMapEntry }
  | { status: Exclude<HostnameMapStatus, "hit"> };

/**
 * Like `lookupHostnameMap`, with the whole entry, for readers that need
 * `resolvedAt` (the warm job's supersede check). Never throws.
 */
export async function lookupHostnameMapEntry(
  store: Pick<HostnameMapStore, "get"> | undefined,
  hostname: string,
  now: number,
): Promise<HostnameMapEntryLookup> {
  if (!store) return { status: "unbound" };
  let text: string | null;
  try {
    text = await store.get(docsHostnameMapKey(hostname));
  } catch {
    return { status: "error" };
  }
  if (text === null) return { status: "miss" };
  const value = parseJson(text);
  const read = readHostnameMapEntry(value, hostname, now);
  if (read.status !== "hit") return read;
  const entry = docsHostnameMapEntrySchema.safeParse(value);
  return entry.success
    ? { status: "hit", entry: entry.data }
    : { status: "invalid" };
}

/** Compares a map read with the resolution that `DocsHostCache` returned. */
export function compareHostnameMap(
  hostname: string,
  lookup: HostnameMapLookup,
  resolution: DocsDomainResolution | null,
): HostnameMapAgreement {
  if (lookup.status === "error" || lookup.status === "unbound") return "error";
  const expected = isStorableHostnameResolution(hostname, resolution)
    ? resolution
    : null;
  if (lookup.status !== "hit") return expected ? "missing" : "agree";
  return expected && sameResolution(lookup.resolution, expected)
    ? "agree"
    : "disagree";
}

function sameResolution(
  left: DocsDomainResolution,
  right: DocsDomainResolution,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(resolution: DocsDomainResolution): string {
  return JSON.stringify(
    Object.entries(resolution)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
