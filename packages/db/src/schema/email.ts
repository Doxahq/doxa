import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const emailDeliveryStatus = pgEnum("email_delivery_status", [
  "queued",
  "sending",
  "sent",
  "failed",
  "suppressed",
]);

export const emailSuppressionReason = pgEnum("email_suppression_reason", [
  "bounce",
  "complaint",
  /** The provider refused the address and did not say why. */
  "provider",
  "manual",
]);

export const emailNotificationCategory = pgEnum("email_notification_category", [
  "approvals",
  "generations",
  "domains",
]);

/**
 * The email outbox and delivery log (email spec §9). A producer inserts a
 * `queued` row, then sends its ID to the email queue. The `doxa-email` Worker
 * claims the row, renders the kind's template, sends it, and records the result.
 */
export const emailDeliveries = pgTable(
  "email_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** An email kind name from `@doxahq/email/catalog`. */
    kind: text("kind").notNull(),
    /** Checked with the kind's schema at insert and again before the render. */
    props: jsonb("props").notNull(),
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    recipientEmail: text("recipient_email").notNull(),
    recipientUserId: text("recipient_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** For example `team-invite:<inviteId>`. A second insert with the same key does nothing. */
    dedupeKey: text("dedupe_key").notNull(),
    status: emailDeliveryStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set by each claim; only the holder of the claim can record the result. */
    claimToken: uuid("claim_token"),
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    lastFailureKind: text("last_failure_kind"),
    lastFailureMessage: text("last_failure_message"),
    lastProviderCode: text("last_provider_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("email_deliveries_dedupe_key_idx").on(table.dedupeKey),
    index("email_deliveries_due_idx")
      .on(table.status, table.nextAttemptAt)
      .where(sql`${table.status} in ('queued', 'sending')`),
    index("email_deliveries_created_idx").on(table.createdAt),
    check("email_deliveries_attempts_positive", sql`${table.attempts} >= 0`),
    check(
      "email_deliveries_failure_message_length",
      sql`${table.lastFailureMessage} IS NULL OR char_length(${table.lastFailureMessage}) <= 1000`,
    ),
  ],
);

/**
 * Addresses that Doxa does not send to. Doxa owns this list, so it stays
 * correct after an email provider swap (email spec §9.1).
 */
export const emailSuppressions = pgTable("email_suppressions", {
  /** Lowercase address. */
  email: text("email").primaryKey(),
  reason: emailSuppressionReason("reason").notNull(),
  /** The provider that reported it, or `doxa` for a manual entry. */
  source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A missing row means the category is on. */
export const emailPreferences = pgTable(
  "email_preferences",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    category: emailNotificationCategory("category").notNull(),
    enabled: boolean("enabled").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.category] })],
);
