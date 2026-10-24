import {
  STORAGE_GC_LIMITS,
  type StorageCollector,
  type StorageGcEntry,
  type StorageGcRunResult,
} from "@doxahq/contracts/storage-gc";

import type { StorageGcStore } from "../../repositories/storage-gc";

type EntryCounts = Pick<
  StorageGcRunResult,
  | "claimed"
  | "collected"
  | "retained"
  | "incomplete"
  | "failed"
  | "skipped"
  | "deletedObjects"
>;

function emptyCounts(): EntryCounts {
  return {
    claimed: 0,
    collected: 0,
    retained: 0,
    incomplete: 0,
    failed: 0,
    skipped: 0,
    deletedObjects: 0,
  };
}

/** An entry with no collector here waits instead of looping every run. */
const UNKNOWN_TARGET_DELAY_SECONDS = 60 * 60;

/**
 * Runs every registered collector against its due entries.
 *
 * The runner owns claiming, leases, retries, and reporting. A collector owns
 * the deletion policy for one kind of resource. This split lets a new feature
 * add collection without a new scheduler.
 */
export class StorageGarbageCollector {
  private readonly collectors: Map<string, StorageCollector>;

  constructor(
    private readonly store: StorageGcStore,
    collectors: readonly StorageCollector[],
  ) {
    this.collectors = new Map(
      collectors.map((collector) => [collector.target, collector]),
    );
  }

  async run(): Promise<StorageGcRunResult> {
    const counts = await this.runEntries(await this.store.claim());
    const pruned = await this.store.prune();
    const health = await this.store.readHealth();
    const result: StorageGcRunResult = { ...counts, pruned, ...health };
    const event = {
      event: "storage_gc_health",
      status:
        counts.failed > 0 || health.exhaustedCount > 0
          ? "degraded"
          : "healthy",
      ...result,
    };
    if (event.status === "degraded") console.warn(JSON.stringify(event));
    else console.info(JSON.stringify(event));
    return result;
  }

  /**
   * Collects the given entries now, when they are due.
   *
   * A feature calls this after the commit that made a resource unreferenced,
   * so the objects go at once. An entry that fails here stays on the work list
   * for the scheduled run.
   */
  async collectNow(entryIds: readonly string[]): Promise<EntryCounts> {
    if (entryIds.length === 0) return emptyCounts();
    return this.runEntries(await this.store.claim(entryIds));
  }

  private async runEntries(
    entries: readonly StorageGcEntry[],
  ): Promise<EntryCounts> {
    const counts = { ...emptyCounts(), claimed: entries.length };

    for (const entry of entries) {
      const outcome = await this.runEntry(entry);
      counts.deletedObjects += outcome.deletedObjects;
      counts[outcome.status] += 1;
    }

    return counts;
  }

  private async runEntry(entry: StorageGcEntry): Promise<{
    status: "collected" | "retained" | "incomplete" | "skipped" | "failed";
    deletedObjects: number;
  }> {
    const collector = this.collectors.get(entry.target);
    if (!collector) {
      // An unknown target belongs to a removed or not yet deployed feature.
      // The entry returns to the work list instead of failing, so no object
      // is lost and no attempt is consumed.
      await this.store.reschedule({
        entryId: entry.id,
        claimToken: entry.claimToken,
        deletedObjects: 0,
        delaySeconds: UNKNOWN_TARGET_DELAY_SECONDS,
      });
      this.logEntryError(entry, "storage_gc_target_unknown", null);
      return { status: "skipped", deletedObjects: 0 };
    }

    try {
      const resource = collector.parse(entry.resource);
      const inspection = await collector.inspect(resource);
      if (
        inspection.status === "retain" &&
        inspection.recheckAfterSeconds !== undefined
      ) {
        await this.store.reschedule({
          entryId: entry.id,
          claimToken: entry.claimToken,
          deletedObjects: 0,
          delaySeconds: inspection.recheckAfterSeconds,
        });
        return { status: "retained", deletedObjects: 0 };
      }
      if (inspection.status === "retain") {
        await this.store.markRetained({
          entryId: entry.id,
          claimToken: entry.claimToken,
          reason: inspection.reason,
        });
        return { status: "retained", deletedObjects: 0 };
      }

      const collection = await collector.collect(resource);
      if (collection.status === "incomplete") {
        await this.store.reschedule({
          entryId: entry.id,
          claimToken: entry.claimToken,
          deletedObjects: collection.deletedObjects,
          ...(collection.recheckAfterSeconds === undefined
            ? {}
            : { delaySeconds: collection.recheckAfterSeconds }),
        });
        return {
          status: "incomplete",
          deletedObjects: collection.deletedObjects,
        };
      }
      await this.store.markCollected({
        entryId: entry.id,
        claimToken: entry.claimToken,
        deletedObjects: collection.deletedObjects,
      });
      return { status: "collected", deletedObjects: collection.deletedObjects };
    } catch (error) {
      await this.store
        .markFailed({
          entryId: entry.id,
          claimToken: entry.claimToken,
          error,
        })
        .catch(() => undefined);
      this.logEntryError(entry, "storage_gc_entry_failed", error);
      return { status: "failed", deletedObjects: 0 };
    }
  }

  private logEntryError(
    entry: StorageGcEntry,
    event: string,
    error: unknown,
  ): void {
    console.error(
      JSON.stringify({
        event,
        entryId: entry.id,
        target: entry.target,
        resourceKey: entry.resourceKey,
        attempt: entry.attempt,
        maxAttempts: STORAGE_GC_LIMITS.maxAttempts,
        errorClass: error instanceof Error ? error.name : "UnknownError",
      }),
    );
  }
}
