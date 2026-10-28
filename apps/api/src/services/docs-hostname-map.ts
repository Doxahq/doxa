import type { DocsDomainResolution } from "@doxahq/contracts";
import {
  DOCS_HOSTNAME_MAP_REFRESH_SECONDS,
  DOCS_HOSTNAME_MAP_SYNC_LIMIT,
  isStorableHostnameResolution,
  normalizeHostnameMapHostname,
  type DocsHostnameMapRpc,
  type DocsHostnameMapUpdate,
} from "@doxahq/contracts/docs-hostname-map";
import type { Env } from "../env";
import { DocsHostnameSourceRepository } from "../repositories/docs-hostname-source";

/**
 * The API half of the docs hostname map (docs/current/production-docs-caching.md,
 * "Hostname Map"). Every entry comes from the same `resolveDocsHost` that the
 * resolver Worker runs, read from the database at sync time, never from the
 * caller of a mutation. The dispatcher stores public production entries and
 * deletes everything else.
 */
export interface DocsHostnameSource {
  resolve(hostname: string): Promise<DocsDomainResolution | null>;
  /** The site's generated hostname and every domain row of the site, in any state. */
  listSiteHostnames(siteId: string): Promise<string[]>;
  /** Every hostname that can be public production now. */
  listPublicHostnames(): Promise<string[]>;
}

/** The API scheduler runs every five minutes. */
const SCHEDULER_INTERVAL_SECONDS = 5 * 60;

/** The reconcile spreads the hostnames over this many scheduler runs. */
export const HOSTNAME_MAP_REFRESH_SLOTS =
  DOCS_HOSTNAME_MAP_REFRESH_SECONDS / SCHEDULER_INTERVAL_SECONDS;

/** Hostnames resolved in parallel; one sync call carries at most this many. */
const RESOLVE_BATCH_SIZE = 25;

/** Only a public production resolution of the same hostname is sent. */
export function toHostnameMapUpdate(
  hostname: string,
  resolution: DocsDomainResolution | null,
  resolvedAt: number,
): DocsHostnameMapUpdate {
  return {
    hostname,
    resolvedAt,
    resolution: isStorableHostnameResolution(hostname, resolution)
      ? resolution
      : null,
  };
}

/**
 * Resolves each hostname now. `resolvedAt` is taken before the read, so an
 * entry is never younger than the database state it holds.
 */
export async function readHostnameMapUpdates(
  source: Pick<DocsHostnameSource, "resolve">,
  hostnames: readonly string[],
  now: () => number,
): Promise<DocsHostnameMapUpdate[]> {
  const updates: DocsHostnameMapUpdate[] = [];
  for (const batch of chunk(hostnames, RESOLVE_BATCH_SIZE)) {
    updates.push(
      ...(await Promise.all(
        batch.map(async (hostname) => {
          const resolvedAt = now();
          return toHostnameMapUpdate(
            hostname,
            await source.resolve(hostname),
            resolvedAt,
          );
        }),
      )),
    );
  }
  return updates;
}

export async function sendHostnameMapUpdates(
  rpc: DocsHostnameMapRpc,
  updates: readonly DocsHostnameMapUpdate[],
): Promise<void> {
  for (const batch of chunk(updates, DOCS_HOSTNAME_MAP_SYNC_LIMIT)) {
    await rpc.syncHostnames({ updates: batch });
  }
}

/** Every hostname that a cache invalidation task can affect. */
export async function hostnamesForTask(
  source: Pick<DocsHostnameSource, "listSiteHostnames">,
  task: { siteId: string; hostname: string | null },
): Promise<string[]> {
  const site = await source.listSiteHostnames(task.siteId);
  return uniqueHostnames(task.hostname ? [task.hostname, ...site] : site);
}

/**
 * Syncs the hostnames of cache invalidation tasks. Use one instance per
 * claimed batch: every claimed task committed before the claim, so one read
 * per hostname after the claim already sees all of them.
 */
export class DocsHostnameMapSync {
  private readonly synced = new Set<string>();

  constructor(
    private readonly source: DocsHostnameSource,
    private readonly rpc: DocsHostnameMapRpc,
    private readonly now: () => number = Date.now,
  ) {}

  async syncTask(task: {
    siteId: string;
    hostname: string | null;
  }): Promise<void> {
    const due = (await hostnamesForTask(this.source, task)).filter(
      (hostname) => !this.synced.has(hostname),
    );
    if (due.length === 0) return;
    await sendHostnameMapUpdates(
      this.rpc,
      await readHostnameMapUpdates(this.source, due, this.now),
    );
    for (const hostname of due) this.synced.add(hostname);
  }
}

/** A hostname's fixed refresh slot. */
export function refreshSlotOf(hostname: string): number {
  return fnv1a(normalizeHostnameMapHostname(hostname)) % HOSTNAME_MAP_REFRESH_SLOTS;
}

/** The slot of the scheduler run at `scheduledTime`. */
export function refreshSlotAt(scheduledTime: number): number {
  return (
    Math.floor(scheduledTime / (SCHEDULER_INTERVAL_SECONDS * 1000)) %
    HOSTNAME_MAP_REFRESH_SLOTS
  );
}

/** The hostnames that the run at `scheduledTime` refreshes. */
export function selectHostnamesDue(
  hostnames: readonly string[],
  scheduledTime: number,
): string[] {
  const slot = refreshSlotAt(scheduledTime);
  return uniqueHostnames(hostnames).filter(
    (hostname) => refreshSlotOf(hostname) === slot,
  );
}

export interface DocsHostnameMapReconcileResult {
  slot: number;
  due: number;
  stored: number;
  deleted: number;
}

/**
 * Rewrites every public hostname once per refresh period, a slot per
 * scheduler run. It fills the map for existing sites, keeps live entries
 * younger than the dispatcher's maximum age, and repairs an entry that a
 * failed sync left behind. It reads the database and writes only the map.
 */
export class DocsHostnameMapReconciler {
  constructor(
    private readonly source: DocsHostnameSource,
    private readonly rpc: DocsHostnameMapRpc,
    private readonly now: () => number = Date.now,
  ) {}

  /** Null without the dispatcher binding, as in local development. */
  static fromEnv(env: Env): DocsHostnameMapReconciler | null {
    return env.DOCS_CACHE_INVALIDATOR
      ? new DocsHostnameMapReconciler(
          new DocsHostnameSourceRepository(env),
          env.DOCS_CACHE_INVALIDATOR,
        )
      : null;
  }

  async run(scheduledTime: number): Promise<DocsHostnameMapReconcileResult> {
    const due = selectHostnamesDue(
      await this.source.listPublicHostnames(),
      scheduledTime,
    );
    const updates = await readHostnameMapUpdates(this.source, due, this.now);
    await sendHostnameMapUpdates(this.rpc, updates);
    const stored = updates.filter((update) => update.resolution).length;
    const result = {
      slot: refreshSlotAt(scheduledTime),
      due: due.length,
      stored,
      deleted: updates.length - stored,
    };
    console.info(
      JSON.stringify({ event: "docs_hostname_map_reconcile", ...result }),
    );
    return result;
  }
}

function uniqueHostnames(hostnames: readonly string[]): string[] {
  return [...new Set(hostnames.map(normalizeHostnameMapHostname))].filter(
    Boolean,
  );
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** 32-bit FNV-1a: a stable spread of hostnames over the refresh slots. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
