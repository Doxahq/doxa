import type { GenerateJobMessage } from "@doxahq/contracts";
import type { Env } from "../../env";
import {
  JobsRepository,
  type DoxabotQueueOutboxJobsStore,
} from "../../repositories/jobs";
import {
  WebhookDeliveriesRepository,
  type WebhookDeliveriesStore,
} from "../../repositories/webhook-deliveries";

const DEFAULT_PUBLICATION_LIMIT = 25;

interface QueuePublisher {
  send(message: GenerateJobMessage): Promise<unknown>;
}

export interface DoxabotQueueOutboxDependencies {
  jobs: DoxabotQueueOutboxJobsStore;
  deliveries: Pick<
    WebhookDeliveriesStore,
    "markEnqueueFailed" | "markGenerationJobPublished"
  >;
  queue: QueuePublisher;
}

export interface DoxabotQueueOutboxResult {
  failed: number;
  published: number;
}

export class DoxabotQueueOutboxPublisher {
  constructor(
    private readonly dependencies: DoxabotQueueOutboxDependencies,
  ) {}

  static fromEnv(env: Env): DoxabotQueueOutboxPublisher {
    return new DoxabotQueueOutboxPublisher({
      jobs: new JobsRepository(env),
      deliveries: new WebhookDeliveriesRepository(env),
      queue: env.GENERATION_QUEUE,
    });
  }

  async publishPending(
    limit = DEFAULT_PUBLICATION_LIMIT,
  ): Promise<DoxabotQueueOutboxResult> {
    const pending =
      await this.dependencies.jobs.listPendingDoxabotQueuePublications(
        limit,
      );
    let failed = 0;
    let published = 0;

    for (const publication of pending) {
      try {
        await this.dependencies.queue.send({
          jobId: publication.jobId,
          projectId: publication.projectId,
          userId: publication.ownerUserId,
        });
        const recorded =
          await this.dependencies.deliveries.markGenerationJobPublished(
            publication.jobId,
          );
        if (!recorded) {
          throw new Error(
            "Queue publication could not be recorded.",
          );
        }
        published += 1;
      } catch {
        await this.dependencies.deliveries.markEnqueueFailed({
          provider: publication.provider,
          deliveryId: publication.deliveryId,
          errorCode: "queue_publication_failed",
        });
        failed += 1;
      }
    }

    return { failed, published };
  }
}
