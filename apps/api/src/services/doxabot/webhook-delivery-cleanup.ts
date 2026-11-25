import type { DbEnv } from "@doxahq/db";
import {
  WebhookDeliveriesRepository,
  type WebhookDeliveryCleanupStore,
} from "../../repositories/webhook-deliveries";

/** Ignored and failed deliveries older than this are deleted. */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One delete statement removes at most this many rows. */
export const WEBHOOK_DELIVERY_CLEANUP_BATCH = 1_000;
/** At most this many batches per cron tick, so one tick stays short. */
export const WEBHOOK_DELIVERY_CLEANUP_MAX_BATCHES = 5;

/**
 * Cron cleanup of `scm_webhook_deliveries`. Every event of every installed
 * repository adds a row, and most are ignored. A backlog shrinks over a few
 * ticks. Returns how many rows it deleted.
 */
export async function cleanUpWebhookDeliveries(
  store: WebhookDeliveryCleanupStore,
  now: Date = new Date(),
): Promise<number> {
  const createdBefore = new Date(now.getTime() - WEBHOOK_DELIVERY_RETENTION_DAYS * DAY_MS);
  let deleted = 0;
  for (let batch = 0; batch < WEBHOOK_DELIVERY_CLEANUP_MAX_BATCHES; batch += 1) {
    const count = await store.deleteOldUnprocessed({
      createdBefore,
      limit: WEBHOOK_DELIVERY_CLEANUP_BATCH,
    });
    deleted += count;
    if (count < WEBHOOK_DELIVERY_CLEANUP_BATCH) break;
  }
  return deleted;
}

export function cleanUpWebhookDeliveriesFromEnv(env: DbEnv): Promise<number> {
  return cleanUpWebhookDeliveries(new WebhookDeliveriesRepository(env));
}
