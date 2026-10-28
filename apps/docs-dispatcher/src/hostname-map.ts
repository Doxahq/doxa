import type { DocsDomainResolution } from "@doxahq/contracts";
import {
  DOCS_HOSTNAME_MAP_EXPIRATION_SECONDS,
  DOCS_HOSTNAME_MAP_FORMAT,
  docsHostnameMapKey,
  docsHostnameMapSyncSchema,
  isStorableHostnameResolution,
  readHostnameMapEntry,
  type DocsHostnameMapEntry,
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

/** The part of a KV namespace that the map uses. */
export interface HostnameMapStore {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options: { expirationTtl: number },
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
 * Applies updates that the API computed from the database. The input is
 * validated again here, and only a public production resolution of the same
 * hostname is stored; every other update deletes the entry.
 */
export async function applyHostnameMapUpdates(
  store: HostnameMapStore,
  input: unknown,
): Promise<void> {
  const { updates } = docsHostnameMapSyncSchema.parse(input);
  await Promise.all(updates.map((update) => applyUpdate(store, update)));
}

function applyUpdate(
  store: HostnameMapStore,
  update: DocsHostnameMapUpdate,
): Promise<void> {
  const key = docsHostnameMapKey(update.hostname);
  if (!isStorableHostnameResolution(update.hostname, update.resolution)) {
    return store.delete(key);
  }
  const entry: DocsHostnameMapEntry = {
    format: DOCS_HOSTNAME_MAP_FORMAT,
    resolvedAt: update.resolvedAt,
    resolution: update.resolution,
  };
  return store.put(key, JSON.stringify(entry), {
    expirationTtl: DOCS_HOSTNAME_MAP_EXPIRATION_SECONDS,
  });
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
