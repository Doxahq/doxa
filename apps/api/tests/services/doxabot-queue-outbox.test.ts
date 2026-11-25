import type { GenerateJobMessage } from "@doxahq/contracts";
import {
  DoxabotQueueOutboxPublisher,
  type DoxabotQueueOutboxDependencies,
} from "../../src/services/doxabot/queue-outbox";
import { describe, expect, test, vi } from "vitest";

const pendingPublication = {
  provider: "github" as const,
  deliveryId: "delivery-1",
  jobId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  ownerUserId: "owner-user",
};

function createHarness() {
  const dependencies: DoxabotQueueOutboxDependencies = {
    jobs: {
      listPendingDoxabotQueuePublications: vi.fn(
        async () => [pendingPublication],
      ),
    },
    deliveries: {
      markGenerationJobPublished: vi.fn(async () => true),
      markEnqueueFailed: vi.fn(async () => {}),
    },
    queue: {
      send: vi.fn(
        async (_message: GenerateJobMessage) => {},
      ),
    },
  };

  return {
    publisher: new DoxabotQueueOutboxPublisher(dependencies),
    ...dependencies,
  };
}

describe("Doxabot queue outbox publisher", () => {
  test("publishes pending jobs and records queue delivery", async () => {
    const harness = createHarness();

    await expect(harness.publisher.publishPending(10)).resolves.toEqual({
      failed: 0,
      published: 1,
    });

    expect(
      harness.jobs.listPendingDoxabotQueuePublications,
    ).toHaveBeenCalledWith(10);
    // A recovered publication keeps the preview quiet window.
    expect(harness.queue.send).toHaveBeenCalledWith(
      {
        jobId: pendingPublication.jobId,
        projectId: pendingPublication.projectId,
        userId: pendingPublication.ownerUserId,
      },
      { delaySeconds: 120 },
    );
    expect(
      harness.deliveries.markGenerationJobPublished,
    ).toHaveBeenCalledWith(pendingPublication.jobId);
    expect(
      harness.deliveries.markEnqueueFailed,
    ).not.toHaveBeenCalled();
  });

  test("keeps failed publications pending for a later retry", async () => {
    const harness = createHarness();
    vi.mocked(harness.queue.send).mockRejectedValueOnce(
      new Error("queue unavailable"),
    );

    await expect(harness.publisher.publishPending()).resolves.toEqual({
      failed: 1,
      published: 0,
    });

    expect(
      harness.deliveries.markGenerationJobPublished,
    ).not.toHaveBeenCalled();
    expect(
      harness.deliveries.markEnqueueFailed,
    ).toHaveBeenCalledWith({
      provider: pendingPublication.provider,
      deliveryId: pendingPublication.deliveryId,
      errorCode: "queue_publication_failed",
    });
  });

  test("retries when queue delivery cannot be recorded", async () => {
    const harness = createHarness();
    vi.mocked(
      harness.deliveries.markGenerationJobPublished,
    ).mockResolvedValueOnce(false);

    await expect(harness.publisher.publishPending()).resolves.toEqual({
      failed: 1,
      published: 0,
    });

    expect(harness.queue.send).toHaveBeenCalledOnce();
    expect(
      harness.deliveries.markEnqueueFailed,
    ).toHaveBeenCalledOnce();
  });
});
