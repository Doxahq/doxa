import { describe, expect, test, vi } from "vitest";
import {
  WEBHOOK_DELIVERY_CLEANUP_BATCH,
  WEBHOOK_DELIVERY_CLEANUP_MAX_BATCHES,
  cleanUpWebhookDeliveries,
} from "../../src/services/doxabot/webhook-delivery-cleanup";
import { CLEANUP_DELIVERY_STATUSES } from "../../src/repositories/webhook-deliveries";

const now = new Date("2026-11-23T12:00:00.000Z");

describe("webhook delivery cleanup", () => {
  test("deletes ignored and failed deliveries older than 30 days, never processed ones", async () => {
    const store = { deleteOldUnprocessed: vi.fn(async () => 12) };

    await expect(cleanUpWebhookDeliveries(store, now)).resolves.toBe(12);

    expect(store.deleteOldUnprocessed).toHaveBeenCalledOnce();
    expect(store.deleteOldUnprocessed).toHaveBeenCalledWith({
      createdBefore: new Date("2026-10-24T12:00:00.000Z"),
      limit: WEBHOOK_DELIVERY_CLEANUP_BATCH,
    });
    expect([...CLEANUP_DELIVERY_STATUSES]).toEqual(["ignored", "failed"]);
  });

  test("deletes a backlog in bounded batches", async () => {
    const store = { deleteOldUnprocessed: vi.fn(async () => WEBHOOK_DELIVERY_CLEANUP_BATCH) };

    await expect(cleanUpWebhookDeliveries(store, now)).resolves.toBe(
      WEBHOOK_DELIVERY_CLEANUP_BATCH * WEBHOOK_DELIVERY_CLEANUP_MAX_BATCHES,
    );
    expect(store.deleteOldUnprocessed).toHaveBeenCalledTimes(WEBHOOK_DELIVERY_CLEANUP_MAX_BATCHES);
  });

  test("stops after the first batch that is not full", async () => {
    const counts = [WEBHOOK_DELIVERY_CLEANUP_BATCH, 3];
    const store = { deleteOldUnprocessed: vi.fn(async () => counts.shift() ?? 0) };

    await expect(cleanUpWebhookDeliveries(store, now)).resolves.toBe(WEBHOOK_DELIVERY_CLEANUP_BATCH + 3);
    expect(store.deleteOldUnprocessed).toHaveBeenCalledTimes(2);
  });
});
