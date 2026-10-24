import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import { createDb, schema, type DbEnv, type DoxaDb } from "@doxahq/db";
import type { ClaimedEmailDelivery, SuppressionReason } from "@doxahq/email";
import type { EmailNotificationCategory } from "@doxahq/email/catalog";
import type {
  DeliveryUpdate,
  EmailDeliveryStore,
  EmailPreferencesStore,
  EmailSuppressionStore,
  NewEmailDelivery,
  StaleLimits,
} from "../services/email/email-delivery-store";

const { emailDeliveries: deliveries, emailSuppressions: suppressions, emailPreferences: preferences } = schema;

const FAILURE_MESSAGE_LIMIT = 1000;

export class EmailDeliveriesRepository implements EmailDeliveryStore {
  constructor(private readonly db: DoxaDb) {}

  static fromEnv(env: DbEnv): EmailDeliveriesRepository {
    return new EmailDeliveriesRepository(createDb(env));
  }

  async insert(delivery: NewEmailDelivery): Promise<string | null> {
    const [row] = await this.db
      .insert(deliveries)
      .values({
        kind: delivery.kind,
        props: delivery.props,
        headers: { ...delivery.headers },
        recipientEmail: delivery.recipientEmail,
        recipientUserId: delivery.recipientUserId,
        dedupeKey: delivery.dedupeKey,
      })
      .onConflictDoNothing({ target: deliveries.dedupeKey })
      .returning({ id: deliveries.id });
    return row?.id ?? null;
  }

  async claim(id: string, now: Date): Promise<ClaimedEmailDelivery | null> {
    const claimToken = crypto.randomUUID();
    const [row] = await this.db
      .update(deliveries)
      .set({ status: "sending", claimToken, attempts: sql`${deliveries.attempts} + 1`, updatedAt: now })
      .where(and(eq(deliveries.id, id), eq(deliveries.status, "queued")))
      .returning({
        id: deliveries.id,
        kind: deliveries.kind,
        props: deliveries.props,
        headers: deliveries.headers,
        recipientEmail: deliveries.recipientEmail,
        attempt: deliveries.attempts,
      });
    return row ? { ...row, claimToken } : null;
  }

  async complete(id: string, claimToken: string, update: DeliveryUpdate, now: Date): Promise<string | null> {
    const [changed] = await this.db
      .update(deliveries)
      .set({ ...toColumns(update, now), claimToken: null, updatedAt: now })
      .where(and(eq(deliveries.id, id), eq(deliveries.status, "sending"), eq(deliveries.claimToken, claimToken)))
      .returning({ recipientEmail: deliveries.recipientEmail });
    return changed?.recipientEmail ?? null;
  }

  takeStale(now: Date, limits: StaleLimits): Promise<string[]> {
    const queuedBefore = new Date(now.getTime() - limits.queuedGraceMs);
    const sendingBefore = new Date(now.getTime() - limits.sendingTimeoutMs);
    return this.db.transaction(async (tx) => {
      const stale = await tx
        .select({ id: deliveries.id })
        .from(deliveries)
        .where(
          or(
            and(eq(deliveries.status, "queued"), lte(deliveries.nextAttemptAt, queuedBefore)),
            and(eq(deliveries.status, "sending"), lte(deliveries.updatedAt, sendingBefore)),
          ),
        )
        .orderBy(deliveries.nextAttemptAt)
        .limit(limits.batchSize)
        .for("update", { skipLocked: true });
      if (stale.length === 0) return [];
      const ids = stale.map((row) => row.id);
      await tx
        .update(deliveries)
        .set({ status: "queued", claimToken: null, nextAttemptAt: now, updatedAt: now })
        .where(inArray(deliveries.id, ids));
      return ids;
    });
  }
}

function toColumns(update: DeliveryUpdate, now: Date) {
  if (update.status === "sent") {
    return { status: update.status, provider: update.provider, providerMessageId: update.providerMessageId, sentAt: now };
  }
  return {
    status: update.status,
    provider: update.provider,
    lastFailureKind: update.failure.kind,
    lastFailureMessage: update.failure.message.slice(0, FAILURE_MESSAGE_LIMIT),
    lastProviderCode: update.failure.providerCode ?? null,
    ...(update.status === "queued" ? { nextAttemptAt: update.retryAt } : {}),
  };
}

export class EmailSuppressionsRepository implements EmailSuppressionStore {
  constructor(private readonly db: DoxaDb) {}

  static fromEnv(env: DbEnv): EmailSuppressionsRepository {
    return new EmailSuppressionsRepository(createDb(env));
  }

  async isSuppressed(email: string): Promise<boolean> {
    const [row] = await this.db
      .select({ email: suppressions.email })
      .from(suppressions)
      .where(eq(suppressions.email, email.toLowerCase()))
      .limit(1);
    return Boolean(row);
  }

  async suppress(entries: readonly { email: string; reason: SuppressionReason; source: string }[]): Promise<number> {
    if (entries.length === 0) return 0;
    const inserted = await this.db
      .insert(suppressions)
      .values(entries.map((entry) => ({ ...entry, email: entry.email.toLowerCase() })))
      .onConflictDoNothing({ target: suppressions.email })
      .returning({ email: suppressions.email });
    return inserted.length;
  }
}

export class EmailPreferencesRepository implements EmailPreferencesStore {
  constructor(private readonly db: DoxaDb) {}

  static fromEnv(env: DbEnv): EmailPreferencesRepository {
    return new EmailPreferencesRepository(createDb(env));
  }

  async disabledCategories(userId: string): Promise<ReadonlySet<EmailNotificationCategory>> {
    const rows = await this.db
      .select({ category: preferences.category })
      .from(preferences)
      .where(and(eq(preferences.userId, userId), eq(preferences.enabled, false)));
    return new Set(rows.map((row) => row.category));
  }

  async set(userId: string, category: EmailNotificationCategory, enabled: boolean, now: Date): Promise<void> {
    await this.db
      .insert(preferences)
      .values({ userId, category, enabled, updatedAt: now })
      .onConflictDoUpdate({
        target: [preferences.userId, preferences.category],
        set: { enabled, updatedAt: now },
      });
  }
}
