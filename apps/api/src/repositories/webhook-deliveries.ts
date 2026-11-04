import {
  sourceControlEventParseResultSchema,
  type SourceControlEventParseResult,
  type SourceProvider,
} from "@doxahq/contracts";
import { createDb, schema, type DbEnv } from "@doxahq/db";
import { and, eq, notInArray } from "drizzle-orm";

export type WebhookDeliveryClaim = "claimed" | "duplicate";

export interface ClaimWebhookDeliveryInput {
  provider: SourceProvider;
  deliveryId: string;
  eventName: string;
  action: string | null;
  repositoryExternalId: string | null;
  payloadHash: string;
  normalizedEvent: SourceControlEventParseResult;
}

export interface WebhookDeliveryIdentity {
  provider: SourceProvider;
  deliveryId: string;
}

export interface WebhookDeliveriesStore {
  claimDelivery(input: ClaimWebhookDeliveryInput): Promise<WebhookDeliveryClaim>;
  getNormalizedEvent(
    input: WebhookDeliveryIdentity,
  ): Promise<SourceControlEventParseResult | null>;
  markProcessed(input: WebhookDeliveryIdentity): Promise<void>;
  markIgnored(
    input: WebhookDeliveryIdentity & { reason: string },
  ): Promise<void>;
  markEnqueueFailed(
    input: WebhookDeliveryIdentity & { errorCode: string },
  ): Promise<void>;
  markGenerationJobPublished(jobId: string): Promise<boolean>;
  markFailed(
    input: WebhookDeliveryIdentity & { errorCode: string },
  ): Promise<void>;
}

export class WebhookDeliveriesRepository implements WebhookDeliveriesStore {
  private readonly db;

  constructor(env: DbEnv) {
    this.db = createDb(env);
  }

  async claimDelivery(
    input: ClaimWebhookDeliveryInput,
  ): Promise<WebhookDeliveryClaim> {
    if (await this.hasSamePayload(input)) return "duplicate";

    const [claimed] = await this.db
      .insert(schema.scmWebhookDeliveries)
      .values(input)
      .onConflictDoNothing({
        target: [
          schema.scmWebhookDeliveries.provider,
          schema.scmWebhookDeliveries.deliveryId,
        ],
      })
      .returning({ id: schema.scmWebhookDeliveries.id });

    return claimed ? "claimed" : "duplicate";
  }

  /**
   * SEC-025: the HMAC covers the body, not the X-GitHub-Delivery header, so a
   * captured signed body can come back with a new delivery ID. A body that an
   * earlier delivery of the same repository and event already brought is a
   * duplicate, unless that delivery failed: then GitHub's redelivery must
   * still run. The repository index keeps the lookup small.
   */
  private async hasSamePayload(input: ClaimWebhookDeliveryInput): Promise<boolean> {
    if (!input.repositoryExternalId) return false;
    const [existing] = await this.db
      .select({ id: schema.scmWebhookDeliveries.id })
      .from(schema.scmWebhookDeliveries)
      .where(
        and(
          eq(schema.scmWebhookDeliveries.repositoryExternalId, input.repositoryExternalId),
          eq(schema.scmWebhookDeliveries.provider, input.provider),
          eq(schema.scmWebhookDeliveries.eventName, input.eventName),
          eq(schema.scmWebhookDeliveries.payloadHash, input.payloadHash),
          notInArray(schema.scmWebhookDeliveries.status, ["failed", "enqueue_failed"]),
        ),
      )
      .limit(1);
    return existing !== undefined;
  }

  async getNormalizedEvent(
    input: WebhookDeliveryIdentity,
  ): Promise<SourceControlEventParseResult | null> {
    const [delivery] = await this.db
      .select({
        normalizedEvent: schema.scmWebhookDeliveries.normalizedEvent,
      })
      .from(schema.scmWebhookDeliveries)
      .where(
        and(
          eq(schema.scmWebhookDeliveries.provider, input.provider),
          eq(schema.scmWebhookDeliveries.deliveryId, input.deliveryId),
        ),
      )
      .limit(1);

    return delivery
      ? sourceControlEventParseResultSchema.parse(delivery.normalizedEvent)
      : null;
  }

  async markProcessed(input: WebhookDeliveryIdentity): Promise<void> {
    await this.updateOutcome(input, {
      status: "processed",
      ignoreReason: null,
      errorCode: null,
      processedAt: new Date(),
    });
  }

  async markIgnored(
    input: WebhookDeliveryIdentity & { reason: string },
  ): Promise<void> {
    await this.updateOutcome(input, {
      status: "ignored",
      ignoreReason: input.reason,
      errorCode: null,
      processedAt: new Date(),
    });
  }

  async markEnqueueFailed(
    input: WebhookDeliveryIdentity & { errorCode: string },
  ): Promise<void> {
    await this.updateOutcome(input, {
      status: "enqueue_failed",
      ignoreReason: null,
      errorCode: input.errorCode,
      processedAt: null,
    });
  }

  async markGenerationJobPublished(jobId: string): Promise<boolean> {
    const publishedAt = new Date();
    const published = await this.db
      .update(schema.scmWebhookDeliveries)
      .set({
        queuePublishedAt: publishedAt,
        status: "processed",
        ignoreReason: null,
        errorCode: null,
        processedAt: publishedAt,
        updatedAt: publishedAt,
      })
      .where(eq(schema.scmWebhookDeliveries.generationJobId, jobId))
      .returning({ id: schema.scmWebhookDeliveries.id });

    return published.length > 0;
  }

  async markFailed(
    input: WebhookDeliveryIdentity & { errorCode: string },
  ): Promise<void> {
    await this.updateOutcome(input, {
      status: "failed",
      ignoreReason: null,
      errorCode: input.errorCode,
      processedAt: new Date(),
    });
  }

  private async updateOutcome(
    identity: WebhookDeliveryIdentity,
    outcome: {
      status: "processed" | "ignored" | "enqueue_failed" | "failed";
      ignoreReason: string | null;
      errorCode: string | null;
      processedAt: Date | null;
    },
  ): Promise<void> {
    await this.db
      .update(schema.scmWebhookDeliveries)
      .set({
        ...outcome,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.scmWebhookDeliveries.provider, identity.provider),
          eq(schema.scmWebhookDeliveries.deliveryId, identity.deliveryId),
        ),
      );
  }
}
