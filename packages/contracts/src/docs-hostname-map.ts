import { z } from "zod";
import {
  DOCS_HOSTNAME_CACHE_TTL_SECONDS,
  docsDomainResolutionSchema,
  type DocsDomainResolution,
} from "./index";
import { docsWarmHintSchema } from "./docs-warm-job";

/**
 * The hostname map is a Workers KV copy of public production hostname
 * resolutions. The API computes every entry from the database and sends it to
 * the dispatcher (`DocsHostCache.syncHostnames`), which owns the namespace.
 * The dispatcher reads it before `DocsHostCache`. See
 * docs/current/production-docs-caching.md, "Hostname Map".
 */

/**
 * Increase when the stored entry changes shape. The dispatcher reads only
 * the format it writes, so a new deploy treats older entries as misses.
 */
export const DOCS_HOSTNAME_MAP_FORMAT = 1;

/**
 * The dispatcher ignores an entry resolved longer ago than this. It bounds a
 * stale entry by the hostname cache lifetime, so storage that an entry can
 * point to already outlives it (`HOSTNAME_READER_GRACE_SECONDS`).
 */
export const DOCS_HOSTNAME_MAP_MAX_AGE_SECONDS =
  DOCS_HOSTNAME_CACHE_TTL_SECONDS;

/** The API rewrites every public hostname at least this often. */
export const DOCS_HOSTNAME_MAP_REFRESH_SECONDS = 12 * 60 * 60;

/** KV removes an entry this long after its last write, such as an orphan. */
export const DOCS_HOSTNAME_MAP_EXPIRATION_SECONDS =
  2 * DOCS_HOSTNAME_MAP_MAX_AGE_SECONDS;

/** An entry resolved this far in the future is invalid. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** The most updates that one sync call can carry. */
export const DOCS_HOSTNAME_MAP_SYNC_LIMIT = 100;

const hostnameSchema = z.string().min(1).max(253);
const resolvedAtSchema = z.number().int().nonnegative();

export const docsHostnameMapEntrySchema = z
  .object({
    format: z.literal(DOCS_HOSTNAME_MAP_FORMAT),
    /** When the API read the resolution from the database (epoch ms). */
    resolvedAt: resolvedAtSchema,
    resolution: docsDomainResolutionSchema,
  })
  .strict();

export type DocsHostnameMapEntry = z.infer<typeof docsHostnameMapEntrySchema>;

/** One hostname's current state: a public resolution to store, or null to delete. */
export const docsHostnameMapUpdateSchema = z
  .object({
    hostname: hostnameSchema,
    resolvedAt: resolvedAtSchema,
    resolution: docsDomainResolutionSchema.nullable(),
  })
  .strict();

export type DocsHostnameMapUpdate = z.infer<typeof docsHostnameMapUpdateSchema>;

export const docsHostnameMapSyncSchema = z
  .object({
    updates: z
      .array(docsHostnameMapUpdateSchema)
      .max(DOCS_HOSTNAME_MAP_SYNC_LIMIT),
    /**
     * Warm-job ordering for the sites whose live version this sync changes
     * (M45): the publisher's pool and the changed pages. Only the API's
     * immediate sync after a publish sends it; retries and the reconcile
     * never do. It never selects what is stored or warmed.
     */
    warm: docsWarmHintSchema.optional(),
  })
  .strict();

export type DocsHostnameMapSync = z.infer<typeof docsHostnameMapSyncSchema>;

/** Lowercase, without a trailing dot, as the cache tags and the resolver use. */
export function normalizeHostnameMapHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

export function docsHostnameMapKey(hostname: string): string {
  return `host:${normalizeHostnameMapHostname(hostname)}`;
}

/**
 * Only a public production resolution of this exact hostname may be stored.
 * Previews, generation snapshots and authenticated sites always go to the
 * resolver.
 */
export function isStorableHostnameResolution(
  hostname: string,
  resolution: DocsDomainResolution | null,
): resolution is DocsDomainResolution {
  return (
    resolution !== null &&
    resolution.renderTarget === "production" &&
    resolution.accessPolicy === "public" &&
    normalizeHostnameMapHostname(resolution.hostname) ===
      normalizeHostnameMapHostname(hostname)
  );
}

export type HostnameMapRead =
  | { status: "hit"; resolution: DocsDomainResolution }
  | { status: "invalid" | "expired" };

/**
 * Checks a stored value for `hostname`. Anything that is not a fresh, public
 * production entry of this hostname in the current format is not a hit.
 */
export function readHostnameMapEntry(
  value: unknown,
  hostname: string,
  now: number,
): HostnameMapRead {
  const parsed = docsHostnameMapEntrySchema.safeParse(value);
  if (!parsed.success) return { status: "invalid" };
  const { resolution, resolvedAt } = parsed.data;
  if (!isStorableHostnameResolution(hostname, resolution)) {
    return { status: "invalid" };
  }
  if (resolvedAt > now + CLOCK_SKEW_MS) return { status: "invalid" };
  if (now - resolvedAt > DOCS_HOSTNAME_MAP_MAX_AGE_SECONDS * 1000) {
    return { status: "expired" };
  }
  return { status: "hit", resolution };
}

/** Private service binding only: the API → dispatcher half of the map. */
export interface DocsHostnameMapRpc {
  syncHostnames(input: DocsHostnameMapSync): Promise<void>;
}
