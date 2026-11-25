import type { OptOutCheck } from "@doxahq/analytics";
import type { PrivacySettingsStore } from "../privacy/privacy-settings-store";

/** An opt-out reaches the other processes within this time. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 5_000;

export interface AnalyticsOptOutCacheOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

interface CachedOptOut {
  readonly optedOut: boolean;
  readonly expiresAt: number;
}

/**
 * `userId -> optedOut` for a few minutes, so analytics does not read the
 * privacy settings for every record. It is bounded: past `maxEntries`, the
 * oldest entry goes. A change in this process replaces its entry at once;
 * other processes see it when their entry expires.
 */
export class AnalyticsOptOutCache {
  readonly #entries = new Map<string, CachedOptOut>();
  readonly #loading = new Map<string, Promise<boolean>>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: AnalyticsOptOutCacheOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#now = options.now ?? Date.now;
  }

  /**
   * The cached answer, or the answer of `load`. `load` runs at once, before
   * this returns, so it can take its database from a request that is still
   * open. Two reads of one user share one load.
   */
  read(userId: string, load: () => Promise<boolean>): Promise<boolean> {
    const cached = this.#entries.get(userId);
    if (cached && cached.expiresAt > this.#now()) return Promise.resolve(cached.optedOut);
    const loading = this.#loading.get(userId);
    if (loading) return loading;

    const task: Promise<boolean> = new Promise<boolean>((resolve) => resolve(load())).then((optedOut) => {
      // A change while the load ran wins over the value that the load read.
      if (this.#loading.get(userId) === task) this.#store(userId, optedOut);
      return optedOut;
    });
    this.#loading.set(userId, task);
    void task.then(
      () => this.#endLoad(userId, task),
      () => this.#endLoad(userId, task),
    );
    return task;
  }

  /** The person changed the setting in this process. */
  remember(userId: string, optedOut: boolean): void {
    this.#loading.delete(userId);
    this.#store(userId, optedOut);
  }

  get size(): number {
    return this.#entries.size;
  }

  #store(userId: string, optedOut: boolean): void {
    this.#entries.delete(userId);
    if (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
    this.#entries.set(userId, { optedOut, expiresAt: this.#now() + this.#ttlMs });
  }

  #endLoad(userId: string, task: Promise<boolean>): void {
    if (this.#loading.get(userId) === task) this.#loading.delete(userId);
  }
}

/** The opt-out check of one env: the cache first, then that env's privacy settings. */
export function cachedOptOutCheck(cache: AnalyticsOptOutCache, store: () => PrivacySettingsStore): OptOutCheck {
  return (userId) => cache.read(userId, async () => !(await store().productAnalyticsEnabled(userId)));
}
