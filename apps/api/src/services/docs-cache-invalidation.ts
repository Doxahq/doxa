import type { DocsCacheInvalidationRpc } from "@doxahq/contracts";
import type { DocsWarmHint } from "@doxahq/contracts/docs-warm-job";
import { createDb } from "@doxahq/db";
import type { Env } from "../env";
import {
  DocsCacheInvalidationsRepository,
  type ClaimedDocsCacheInvalidation,
  type DocsCacheInvalidationStore,
} from "../repositories/docs-cache-invalidations";
import { DocsHostnameSourceRepository } from "../repositories/docs-hostname-source";
import {
  DocsHostnameMapSync,
  type DocsHostnameSource,
} from "./docs-hostname-map";

type DeliveryFailureCode =
  | "binding_missing"
  | "purge_timeout"
  | "purge_failed"
  | "hostname_sync_timeout"
  | "hostname_sync_failed";

class DeliveryAttemptError extends Error {
  constructor(readonly code: DeliveryFailureCode) {
    super(code);
  }
}

const PURGE_TIMEOUT_MS = 3_000;
const HOSTNAME_SYNC_TIMEOUT_MS = 3_000;
const INITIAL_RETRY_DELAY_SECONDS = 30;
const MAX_RETRY_DELAY_SECONDS = 3_600;

export interface DocsCacheInvalidationProcessOptions {
  /**
   * Warm-job ordering for the map sync (M45). Only the immediate delivery
   * after a publish passes it; scheduler retries never do.
   */
  warm?: DocsWarmHint;
}

export interface DocsCacheInvalidationProcessResult {
  completed: number;
  failed: number;
}

/**
 * Delivers a task: purges the hostname cache and, when a hostname source is
 * configured, rewrites the hostname map for every hostname the task can
 * affect. A task completes only when both succeed; a retry repeats both,
 * which is safe because each reads the current state.
 */
export class DocsCacheInvalidationWorker {
  constructor(
    private readonly store: DocsCacheInvalidationStore,
    private readonly binding: DocsCacheInvalidationRpc | undefined,
    private readonly hostnames?: DocsHostnameSource,
  ) {}

  static fromEnv(env: Env): DocsCacheInvalidationWorker {
    return new DocsCacheInvalidationWorker(
      new DocsCacheInvalidationsRepository(createDb(env)),
      env.DOCS_CACHE_INVALIDATOR,
      new DocsHostnameSourceRepository(env),
    );
  }

  async process(
    ids?: string[],
    options: DocsCacheInvalidationProcessOptions = {},
  ): Promise<DocsCacheInvalidationProcessResult> {
    const tasks = await this.store.claim(ids);
    const hostnameSync = this.createHostnameSync(options.warm);
    let completed = 0;
    let failed = 0;
    for (const task of tasks) {
      try {
        await this.deliver(task, hostnameSync);
        await this.store.complete(task);
        completed += 1;
      } catch (error) {
        const code =
          error instanceof DeliveryAttemptError ? error.code : "purge_failed";
        const delaySeconds = Math.min(
          MAX_RETRY_DELAY_SECONDS,
          INITIAL_RETRY_DELAY_SECONDS * 2 ** Math.min(7, task.attempts - 1),
        );
        await this.store.fail(task, code, delaySeconds);
        console.warn("Docs cache invalidation deferred", {
          taskId: task.id,
          attempts: task.attempts,
          code,
        });
        failed += 1;
      }
    }
    return { completed, failed };
  }

  /** One sync per claimed batch, so each hostname is read and written once. */
  private createHostnameSync(warm?: DocsWarmHint): DocsHostnameMapSync | null {
    return this.binding && this.hostnames
      ? new DocsHostnameMapSync(this.hostnames, this.binding, Date.now, warm)
      : null;
  }

  /** The purge always runs, even when the map sync fails, and the other way round. */
  private async deliver(
    task: ClaimedDocsCacheInvalidation,
    hostnameSync: DocsHostnameMapSync | null,
  ): Promise<void> {
    if (!this.binding) throw new DeliveryAttemptError("binding_missing");
    const binding = this.binding;
    const [purge, sync] = await Promise.allSettled([
      withTimeout(
        binding.invalidate({
          siteId: task.siteId,
          ...(task.hostname ? { hostname: task.hostname } : {}),
        }),
        PURGE_TIMEOUT_MS,
        "purge_timeout",
      ),
      hostnameSync
        ? withTimeout(
            hostnameSync.syncTask(task),
            HOSTNAME_SYNC_TIMEOUT_MS,
            "hostname_sync_timeout",
          )
        : Promise.resolve(),
    ]);
    if (purge.status === "rejected") {
      throw asAttemptError(purge.reason, "purge_failed");
    }
    if (sync.status === "rejected") {
      throw asAttemptError(sync.reason, "hostname_sync_failed");
    }
  }
}

function asAttemptError(
  error: unknown,
  fallback: DeliveryFailureCode,
): DeliveryAttemptError {
  return error instanceof DeliveryAttemptError
    ? error
    : new DeliveryAttemptError(fallback);
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  code: DeliveryFailureCode,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DeliveryAttemptError(code)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
