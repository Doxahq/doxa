import type { DocsCacheInvalidationRpc } from "@doxahq/contracts";
import { createDb } from "@doxahq/db";
import type { Env } from "../env";
import {
  DocsCacheInvalidationsRepository,
  type ClaimedDocsCacheInvalidation,
  type DocsCacheInvalidationStore,
} from "../repositories/docs-cache-invalidations";

class PurgeAttemptError extends Error {
  constructor(readonly code: "binding_missing" | "purge_timeout") {
    super(code);
  }
}

const PURGE_TIMEOUT_MS = 3_000;
const INITIAL_RETRY_DELAY_SECONDS = 30;
const MAX_RETRY_DELAY_SECONDS = 3_600;

export interface DocsCacheInvalidationProcessResult {
  completed: number;
  failed: number;
}

export class DocsCacheInvalidationWorker {
  constructor(
    private readonly store: DocsCacheInvalidationStore,
    private readonly binding: DocsCacheInvalidationRpc | undefined,
  ) {}

  static fromEnv(env: Env): DocsCacheInvalidationWorker {
    return new DocsCacheInvalidationWorker(
      new DocsCacheInvalidationsRepository(createDb(env)),
      env.DOCS_CACHE_INVALIDATOR,
    );
  }

  async process(ids?: string[]): Promise<DocsCacheInvalidationProcessResult> {
    const tasks = await this.store.claim(ids);
    let completed = 0;
    let failed = 0;
    for (const task of tasks) {
      try {
        await this.purge(task);
        await this.store.complete(task);
        completed += 1;
      } catch (error) {
        const code =
          error instanceof PurgeAttemptError ? error.code : "purge_failed";
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

  private async purge(task: ClaimedDocsCacheInvalidation): Promise<void> {
    if (!this.binding) throw new PurgeAttemptError("binding_missing");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.binding.invalidate({
          siteId: task.siteId,
          ...(task.hostname ? { hostname: task.hostname } : {}),
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new PurgeAttemptError("purge_timeout")),
            PURGE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
