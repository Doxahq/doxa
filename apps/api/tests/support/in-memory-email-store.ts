import type { ClaimedEmailDelivery, EmailQueueMessage, SuppressionReason } from "@doxahq/email";
import type { EmailDeliveryStatus } from "@doxahq/contracts/email-deliveries";
import type { EmailNotificationCategory } from "@doxahq/email/catalog";
import type {
  DeliveryUpdate,
  EmailDeliveryStore,
  EmailPreferencesStore,
  EmailSuppressionStore,
  NewEmailDelivery,
  StaleLimits,
} from "../../src/services/email/email-delivery-store";
import type { EmailQueueProducer } from "../../src/services/email/email-outbox";

export interface StoredDelivery extends NewEmailDelivery {
  id: string;
  status: EmailDeliveryStatus;
  attempts: number;
  claimToken: string | null;
  nextAttemptAt: Date;
  updatedAt: Date;
  createdAt: Date;
  provider: string | null;
  providerMessageId: string | null;
  lastFailureKind: string | null;
  lastFailureMessage: string | null;
}

/** The three email tables in memory, with the same rules as the SQL repositories. */
export class InMemoryEmailStore implements EmailDeliveryStore, EmailSuppressionStore, EmailPreferencesStore {
  readonly deliveries: StoredDelivery[] = [];
  readonly suppressions = new Map<string, { reason: SuppressionReason; source: string }>();
  private readonly disabled = new Set<string>();
  private nextId = 1;

  constructor(private readonly clock: () => Date = () => new Date("2026-10-07T12:00:00Z")) {}

  async insert(delivery: NewEmailDelivery): Promise<string | null> {
    if (this.deliveries.some((row) => row.dedupeKey === delivery.dedupeKey)) return null;
    const now = this.clock();
    const id = `delivery-${this.nextId++}`;
    this.deliveries.push({
      ...delivery,
      id,
      status: "queued",
      attempts: 0,
      claimToken: null,
      nextAttemptAt: now,
      updatedAt: now,
      createdAt: now,
      provider: null,
      providerMessageId: null,
      lastFailureKind: null,
      lastFailureMessage: null,
    });
    return id;
  }

  async claim(id: string, now: Date): Promise<ClaimedEmailDelivery | null> {
    const row = this.find(id);
    if (!row || row.status !== "queued") return null;
    row.status = "sending";
    row.attempts += 1;
    row.claimToken = `claim-${row.id}-${row.attempts}`;
    row.updatedAt = now;
    return {
      id: row.id,
      kind: row.kind,
      props: row.props,
      headers: row.headers,
      recipientEmail: row.recipientEmail,
      claimToken: row.claimToken,
      attempt: row.attempts,
    };
  }

  async complete(id: string, claimToken: string, update: DeliveryUpdate, now: Date): Promise<string | null> {
    const row = this.find(id);
    if (!row || row.status !== "sending" || row.claimToken !== claimToken) return null;
    row.status = update.status;
    row.provider = update.provider;
    row.claimToken = null;
    row.updatedAt = now;
    if (update.status === "sent") {
      row.providerMessageId = update.providerMessageId;
    } else {
      row.lastFailureKind = update.failure.kind;
      row.lastFailureMessage = update.failure.message;
      if (update.status === "queued") row.nextAttemptAt = update.retryAt;
    }
    return row.recipientEmail;
  }

  async takeStale(now: Date, limits: StaleLimits): Promise<string[]> {
    const stale = this.deliveries
      .filter(
        (row) =>
          (row.status === "queued" && row.nextAttemptAt.getTime() <= now.getTime() - limits.queuedGraceMs) ||
          (row.status === "sending" && row.updatedAt.getTime() <= now.getTime() - limits.sendingTimeoutMs),
      )
      .slice(0, limits.batchSize);
    for (const row of stale) {
      row.status = "queued";
      row.claimToken = null;
      row.nextAttemptAt = now;
      row.updatedAt = now;
    }
    return stale.map((row) => row.id);
  }

  async isSuppressed(email: string): Promise<boolean> {
    return this.suppressions.has(email.toLowerCase());
  }

  async suppress(entries: readonly { email: string; reason: SuppressionReason; source: string }[]): Promise<number> {
    let added = 0;
    for (const entry of entries) {
      const email = entry.email.toLowerCase();
      if (this.suppressions.has(email)) continue;
      this.suppressions.set(email, { reason: entry.reason, source: entry.source });
      added += 1;
    }
    return added;
  }

  async disabledCategories(userId: string): Promise<ReadonlySet<EmailNotificationCategory>> {
    const categories: EmailNotificationCategory[] = ["approvals", "generations", "domains"];
    return new Set(categories.filter((category) => this.disabled.has(`${userId}:${category}`)));
  }

  async set(userId: string, category: EmailNotificationCategory, enabled: boolean): Promise<void> {
    if (enabled) this.disabled.delete(`${userId}:${category}`);
    else this.disabled.add(`${userId}:${category}`);
  }

  private find(id: string): StoredDelivery | undefined {
    return this.deliveries.find((row) => row.id === id);
  }
}

/** Records queue sends; `failNext` makes the next `send` reject. */
export class RecordingEmailQueue implements EmailQueueProducer {
  readonly messages: EmailQueueMessage[] = [];
  private failures = 0;

  failNext(): void {
    this.failures += 1;
  }

  async send(message: EmailQueueMessage): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("Queue unavailable.");
    }
    this.messages.push(message);
  }

  async sendBatch(messages: Iterable<{ body: EmailQueueMessage }>): Promise<void> {
    for (const message of messages) this.messages.push(message.body);
  }
}
