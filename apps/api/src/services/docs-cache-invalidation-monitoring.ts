import { createDb } from "@doxahq/db";
import type { Env } from "../env";
import {
  DocsCacheInvalidationsRepository,
  type DocsCacheInvalidationHealth,
  type DocsCacheInvalidationHealthStore,
} from "../repositories/docs-cache-invalidations";
import {
  DocsCacheInvalidationWorker,
  type DocsCacheInvalidationProcessResult,
} from "./docs-cache-invalidation";

interface DocsCacheInvalidationProcessor {
  process(): Promise<DocsCacheInvalidationProcessResult>;
}

export interface DocsCacheInvalidationHealthEvent {
  event: "docs_cache_invalidation_health";
  status: "healthy" | "degraded";
  processed: DocsCacheInvalidationProcessResult;
  queue: DocsCacheInvalidationHealth;
}

export class DocsCacheInvalidationMaintenance {
  constructor(
    private readonly processor: DocsCacheInvalidationProcessor,
    private readonly healthStore: DocsCacheInvalidationHealthStore,
  ) {}

  static fromEnv(env: Env): DocsCacheInvalidationMaintenance {
    const repository = new DocsCacheInvalidationsRepository(createDb(env));
    return new DocsCacheInvalidationMaintenance(
      new DocsCacheInvalidationWorker(repository, env.DOCS_CACHE_INVALIDATOR),
      repository,
    );
  }

  async run(): Promise<DocsCacheInvalidationHealthEvent> {
    const processed = await this.processor.process();
    const queue = await this.healthStore.readHealth();
    const event = createHealthEvent(processed, queue);
    if (event.status === "degraded") {
      console.warn(JSON.stringify(event));
    } else {
      console.info(JSON.stringify(event));
    }
    return event;
  }
}

function createHealthEvent(
  processed: DocsCacheInvalidationProcessResult,
  queue: DocsCacheInvalidationHealth,
): DocsCacheInvalidationHealthEvent {
  return {
    event: "docs_cache_invalidation_health",
    status:
      queue.delayedCount > 0 || queue.failedCount > 0 ? "degraded" : "healthy",
    processed,
    queue,
  };
}
