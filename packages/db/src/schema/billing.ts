import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { projects, teams } from "./doxa";

/*
 * Billing tables (docs/billing/spec.md section 16). Only `@doxahq/billing`
 * writes them. Credit amounts are `bigint`, money amounts are integer cents,
 * and every timestamp is `timestamptz`.
 *
 * Store mapping (`packages/billing/src/store/postgres.ts`):
 * - USD model costs are `numeric(24, 12)`, read and written as decimal text,
 *   never as a JS float; the store converts them to bigint picodollars.
 * - The markup is an integer in hundredths (`markup_hundredths`, 300 = 3x),
 *   the same exact value the meter uses.
 * - The store's `ownerKind`/`ownerId` map to `owner_user_id` or
 *   `owner_team_id`; a missing provider is stored as `none`.
 *
 * Retention (section 16.3): billing records stay for 7 years for tax and
 * dispute records. No billing row is removed with a user, team or project:
 * the references to `user`, `teams` and `projects` use `set null`, and the
 * references between billing tables use `restrict`. Only the short-lived
 * rows (accruals, usage counters) cascade from their parent.
 */

export const billingOwnerKind = pgEnum("billing_owner_kind", ["user", "team"]);

/** The provider's subscription status, mirrored by `syncCustomer` (section 9.1). */
export const billingSubscriptionStatus = pgEnum("billing_subscription_status", [
  "trialing",
  "active",
  "past_due",
  "incomplete",
  "incomplete_expired",
  "canceled",
  "unpaid",
  "paused",
]);

export const creditGrantKind = pgEnum("credit_grant_kind", [
  "allowance",
  "trial",
  "promo",
  "adjustment",
]);

export const creditReservationStatus = pgEnum("credit_reservation_status", [
  "held",
  "settled",
  "released",
]);

export const creditStopReason = pgEnum("credit_stop_reason", [
  "credits_exhausted",
  "credit_cap",
]);

export const creditLedgerEntryKind = pgEnum("credit_ledger_entry_kind", [
  "grant",
  "debit",
  "debt",
  "debt_paid",
  "release",
  "expire",
  "revoke",
  "adjust",
  "shortfall",
]);

export const billingOfferSlotState = pgEnum("billing_offer_slot_state", [
  "held",
  "claimed",
  "released",
]);

/** The provider's invoice status. The debt of the invoice clears at `paid`. */
export const paygInvoiceStatus = pgEnum("payg_invoice_status", [
  "draft",
  "open",
  "paid",
  "failed",
  "void",
]);

export const paygInvoiceReason = pgEnum("payg_invoice_reason", [
  "threshold",
  "sweep",
  "pay_now",
  "renewal",
]);

export const billingProviderEventStatus = pgEnum(
  "billing_provider_event_status",
  ["received", "processed", "failed"],
);

/**
 * A billing account pays and holds credits (section 8). It belongs to one
 * user or one team. A deletion of the owner clears the owner column and the
 * account stays, anonymized, for its ledger, grant and invoice rows.
 */
export const billingAccounts = pgTable(
  "billing_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerKind: billingOwnerKind("owner_kind").notNull(),
    /** Set when `owner_kind = 'user'`. Null after the user is deleted. */
    ownerUserId: text("owner_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** Set when `owner_kind = 'team'`. Null after the team is deleted. */
    ownerTeamId: uuid("owner_team_id").references(() => teams.id, {
      onDelete: "set null",
    }),
    /** A display name for invoices and the dashboard. Removed at anonymization. */
    name: text("name"),
    /** A provider name from `BILLING_PROVIDERS`, for example `stripe` or `none`. */
    provider: text("provider").notNull(),
    /** Null until `ensureCustomer` creates the provider customer. */
    providerCustomerId: text("provider_customer_id"),
    /** A cache of the effective plan. `resolveEntitlements` is the truth. */
    planKey: text("plan_key").notNull(),
    /** Every write to the account row increments it (section 9.2). */
    stateVersion: bigint("state_version", { mode: "number" })
      .notNull()
      .default(1),
    /** Set for an operator review, for example an open dispute (section 10.4). */
    flaggedAt: timestamp("flagged_at", { withTimezone: true }),
    paygEnabled: boolean("payg_enabled").notNull().default(false),
    /** Written at account creation from the catalog default (`defaultMonthlyLimitCents`). */
    paygMonthlyLimitCents: integer("payg_monthly_limit_cents").notNull(),
    /** `payment_failed` or `dispute`. Null when AI is not paused. */
    aiPausedReason: text("ai_paused_reason"),
    /** The account's cap for each metered action: `{ "<actionKey>": credits }`. */
    actionCaps: jsonb("action_caps")
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    /**
     * The account's Checkout that may still be paid (migration 0048): two
     * tabs or a retry reuse it, so one account never pays two subscriptions.
     * `open_checkout_id` is null while a request creates the Checkout; then
     * `open_checkout_expires_at` is the end of that request's lease.
     */
    openCheckoutId: text("open_checkout_id"),
    openCheckoutPriceKey: text("open_checkout_price_key"),
    openCheckoutExpiresAt: timestamp("open_checkout_expires_at", { withTimezone: true }),
    /** The start of the last allowance window whose monthly pay-as-you-go sweep ran (section 10.10 step 6). */
    paygSweptWindowStart: timestamp("payg_swept_window_start", { withTimezone: true }),
    anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Unique (owner_kind, owner_id): one account for each user and each team.
    uniqueIndex("billing_accounts_owner_user_idx")
      .on(table.ownerUserId)
      .where(sql`${table.ownerUserId} IS NOT NULL`),
    uniqueIndex("billing_accounts_owner_team_idx")
      .on(table.ownerTeamId)
      .where(sql`${table.ownerTeamId} IS NOT NULL`),
    uniqueIndex("billing_accounts_provider_customer_idx").on(
      table.provider,
      table.providerCustomerId,
    ),
    check(
      "billing_accounts_owner_matches_kind",
      sql`(${table.ownerKind} = 'user' AND ${table.ownerTeamId} IS NULL) OR (${table.ownerKind} = 'team' AND ${table.ownerUserId} IS NULL)`,
    ),
    check(
      "billing_accounts_state_version_positive",
      sql`${table.stateVersion} >= 0`,
    ),
    check(
      "billing_accounts_payg_monthly_limit_positive",
      sql`${table.paygMonthlyLimitCents} > 0`,
    ),
    check(
      "billing_accounts_ai_paused_reason_valid",
      sql`${table.aiPausedReason} IS NULL OR ${table.aiPausedReason} IN ('payment_failed', 'dispute')`,
    ),
    check(
      "billing_accounts_action_caps_object",
      sql`jsonb_typeof(${table.actionCaps}) = 'object'`,
    ),
  ],
);

/** The mirror of the provider's subscription, one row for each account. Only `syncCustomer` writes it. */
export const billingSubscriptions = pgTable(
  "billing_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => billingAccounts.id, { onDelete: "restrict" }),
    /** A provider name from `BILLING_PROVIDERS`, for example `stripe`. */
    provider: text("provider").notNull(),
    providerSubscriptionId: text("provider_subscription_id").notNull(),
    /** A catalog price key, for example `pro_yearly_founder_v1`. */
    priceKey: text("price_key").notNull(),
    /** The plan the provider names. Null when it names none (the price key decides). */
    planKey: text("plan_key"),
    status: billingSubscriptionStatus("status").notNull(),
    /** The start of the monthly allowance windows (section 10.3). */
    billingAnchor: timestamp("billing_anchor", { withTimezone: true }).notNull(),
    currentPeriodStart: timestamp("current_period_start", {
      withTimezone: true,
    }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", {
      withTimezone: true,
    }).notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    trialEnd: timestamp("trial_end", { withTimezone: true }),
    /** When the subscription entered `past_due`. The D5 grace period counts from here. */
    pastDueSince: timestamp("past_due_since", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("billing_subscriptions_provider_subscription_idx").on(
      table.provider,
      table.providerSubscriptionId,
    ),
    uniqueIndex("billing_subscriptions_account_idx").on(table.accountId),
    index("billing_subscriptions_status_idx").on(table.status),
    check(
      "billing_subscriptions_period_order",
      sql`${table.currentPeriodEnd} >= ${table.currentPeriodStart}`,
    ),
  ],
);

/** Enterprise terms and support grants: a plan or a single key value (section 9.1). */
export const billingOverrides = pgTable(
  "billing_overrides",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => billingAccounts.id, { onDelete: "restrict" }),
    /** `plan`, or a feature or limit key such as `site.custom_domains`. */
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    reason: text("reason").notNull(),
    /** Null applies from the start. */
    startsAt: timestamp("starts_at", { withTimezone: true }),
    /** Null never expires. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** The operator who made it (user ID or CLI name). No reference: it outlives the user. */
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("billing_overrides_account_key_idx").on(table.accountId, table.key),
    check(
      "billing_overrides_window_order",
      sql`${table.expiresAt} IS NULL OR ${table.startsAt} IS NULL OR ${table.expiresAt} > ${table.startsAt}`,
    ),
  ],
);

/** Credits added to an account (section 10.1). */
export const creditGrants = pgTable(
  "credit_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => billingAccounts.id, { onDelete: "restrict" }),
    kind: creditGrantKind("kind").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    remaining: bigint("remaining", { mode: "number" }).notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    /** Null never expires. An allowance grant expires at its window end. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** The idempotency key, for example `allowance:<accountId>:<windowStart>`. */
    sourceRef: text("source_ref").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("credit_grants_account_source_ref_idx").on(
      table.accountId,
      table.sourceRef,
    ),
    index("credit_grants_account_expires_idx").on(
      table.accountId,
      table.expiresAt,
    ),
    check(
      "credit_grants_remaining_in_range",
      sql`${table.remaining} >= 0 AND ${table.remaining} <= ${table.amount}`,
    ),
    check(
      "credit_grants_window_order",
      sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.startsAt}`,
    ),
  ],
);

/**
 * Credits held for one running action (section 10.5). `amount` is the hold and
 * grows in steps for a metered action, up to `cap_credits`.
 */
export const creditReservations = pgTable(
  "credit_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => billingAccounts.id, { onDelete: "restrict" }),
    /** A catalog action key, for example `generation.run`. */
    actionKey: text("action_key").notNull(),
    /** For example `job` or `chat_request`. */
    subjectKind: text("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    /** The project of the action, for the estimate. Null after the project is deleted. */
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    amount: bigint("amount", { mode: "number" }).notNull(),
    baseCredits: bigint("base_credits", { mode: "number" }).notNull(),
    capCredits: bigint("cap_credits", { mode: "number" }).notNull(),
    /** The exact sum of the accruals. Rounded once, at settle. */
    consumedCostUsd: numeric("consumed_cost_usd", { precision: 24, scale: 12 })
      .notNull()
      .default("0"),
    /** The markup in hundredths: 300 is 3x. An integer, so the price math stays exact. */
    markupHundredths: integer("markup_hundredths").notNull(),
    /** The catalog's price of one credit, in cents, at reserve time. */
    unitPriceCents: integer("unit_price_cents").notNull(),
    /** The headroom the meter keeps before it extends or stops (section 10.5). */
    inFlightMarginCredits: bigint("in_flight_margin_credits", {
      mode: "number",
    }).notNull(),
    stopReason: creditStopReason("stop_reason"),
    status: creditReservationStatus("status").notNull().default("held"),
    /** For example `job:<id>:reserve`. A repeat returns the first reservation. */
    idempotencyKey: text("idempotency_key").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    settledAmount: bigint("settled_amount", { mode: "number" }),
    /** Set when the status leaves `held` (settle or release). */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("credit_reservations_idempotency_key_idx").on(
      table.idempotencyKey,
    ),
    index("credit_reservations_account_held_idx")
      .on(table.accountId)
      .where(sql`${table.status} = 'held'`),
    index("credit_reservations_held_expires_idx")
      .on(table.expiresAt)
      .where(sql`${table.status} = 'held'`),
    index("credit_reservations_subject_idx").on(
      table.subjectKind,
      table.subjectId,
    ),
    index("credit_reservations_project_action_idx").on(
      table.projectId,
      table.actionKey,
      table.createdAt,
    ),
    check(
      "credit_reservations_amounts_valid",
      sql`${table.baseCredits} >= 0 AND ${table.capCredits} >= 0 AND ${table.amount} >= 0 AND ${table.amount} <= ${table.capCredits} AND ${table.inFlightMarginCredits} >= 0`,
    ),
    check(
      "credit_reservations_cost_positive",
      sql`${table.consumedCostUsd} >= 0`,
    ),
    check(
      "credit_reservations_markup_positive",
      sql`${table.markupHundredths} > 0`,
    ),
    check(
      "credit_reservations_unit_price_positive",
      sql`${table.unitPriceCents} >= 0`,
    ),
    check(
      "credit_reservations_settled_amount_valid",
      sql`${table.settledAmount} IS NULL OR ${table.settledAmount} >= 0`,
    ),
    check(
      "credit_reservations_settled_has_amount",
      sql`${table.status} <> 'settled' OR ${table.settledAmount} IS NOT NULL`,
    ),
    check(
      "credit_reservations_closed_together",
      sql`(${table.status} = 'held') = (${table.closedAt} IS NULL)`,
    ),
  ],
);

/**
 * The model cost of one model call, added to its reservation. Deleted 35 days
 * after the settle; `generation_usage_records` keeps the detail.
 */
export const creditAccruals = pgTable(
  "credit_accruals",
  {
    /** The usage record's call ID. A repeated record adds nothing. */
    callId: text("call_id").primaryKey(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => creditReservations.id, { onDelete: "cascade" }),
    /**
     * Null when the model had no price (`credits.unpriced_model`): the call
     * adds 0 to the reservation, and the row keeps that the cost was unknown.
     */
    costUsd: numeric("cost_usd", { precision: 24, scale: 12 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("credit_accruals_reservation_idx").on(table.reservationId),
    index("credit_accruals_created_idx").on(table.createdAt),
    check(
      "credit_accruals_cost_positive",
      sql`${table.costUsd} IS NULL OR ${table.costUsd} >= 0`,
    ),
  ],
);

/**
 * One row for each catalog offer, the lock row of its slots. The catalog
 * sync copies `max_accounts`; the store creates a missing row (with a null
 * `max_accounts`) when it first locks the offer. Checkout locks this row
 * (`FOR UPDATE`) before it counts slots (section 7.5). The catalog stays the
 * source of the limit.
 */
export const billingOffers = pgTable(
  "billing_offers",
  {
    offerKey: text("offer_key").primaryKey(),
    maxAccounts: integer("max_accounts"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "billing_offers_max_accounts_positive",
      sql`${table.maxAccounts} IS NULL OR ${table.maxAccounts} > 0`,
    ),
  ],
);

/** One founder slot for each billing account (section 7.5). */
export const billingOfferSlots = pgTable(
  "billing_offer_slots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    offerKey: text("offer_key")
      .notNull()
      .references(() => billingOffers.offerKey, { onDelete: "restrict" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => billingAccounts.id, { onDelete: "restrict" }),
    state: billingOfferSlotState("state").notNull(),
    checkoutSessionId: text("checkout_session_id"),
    /** The Checkout Session expiry, or the trial end. */
    heldUntil: timestamp("held_until", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("billing_offer_slots_offer_account_idx").on(
      table.offerKey,
      table.accountId,
    ),
    index("billing_offer_slots_offer_state_idx").on(
      table.offerKey,
      table.state,
    ),
    index("billing_offer_slots_checkout_session_idx")
      .on(table.checkoutSessionId)
      .where(sql`${table.checkoutSessionId} IS NOT NULL`),
    index("billing_offer_slots_held_until_idx")
      .on(table.heldUntil)
      .where(sql`${table.state} = 'held'`),
    check(
      "billing_offer_slots_held_has_until",
      sql`${table.state} <> 'held' OR ${table.heldUntil} IS NOT NULL`,
    ),
    check(
      "billing_offer_slots_claimed_has_at",
      sql`${table.state} <> 'claimed' OR ${table.claimedAt} IS NOT NULL`,
    ),
  ],
);

/**
 * The credit ledger (section 10.2). Append-only: no update, no delete.
 * `credits` is signed. Each row has its own idempotency key; a write that
 * makes several rows (a debit over two grants) gives each row a suffix
 * (`K#0`, `K#1`, ...). `sequence` orders the rows of one account (the
 * `created_at` of rows in one transaction is the same).
 */
export const creditLedgerEntries = pgTable(
  "credit_ledger_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequence: bigint("sequence", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => billingAccounts.id, { onDelete: "restrict" }),
    kind: creditLedgerEntryKind("kind").notNull(),
    credits: bigint("credits", { mode: "number" }).notNull(),
    grantId: uuid("grant_id").references(() => creditGrants.id, {
      onDelete: "restrict",
    }),
    reservationId: uuid("reservation_id").references(
      () => creditReservations.id,
      { onDelete: "restrict" },
    ),
    actionKey: text("action_key"),
    subjectKind: text("subject_kind"),
    subjectId: text("subject_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    /** For a settle: `modelCostUsd`, `markup`, `baseCredits`, `capCredits`, `priceTableHash`, `outcome` (section 10.8). */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("credit_ledger_entries_idempotency_key_idx").on(
      table.idempotencyKey,
    ),
    index("credit_ledger_entries_account_created_idx").on(
      table.accountId,
      table.createdAt,
    ),
    index("credit_ledger_entries_account_sequence_idx").on(
      table.accountId,
      table.sequence,
    ),
    index("credit_ledger_entries_grant_idx")
      .on(table.grantId)
      .where(sql`${table.grantId} IS NOT NULL`),
    index("credit_ledger_entries_reservation_idx")
      .on(table.reservationId)
      .where(sql`${table.reservationId} IS NOT NULL`),
  ],
);

/**
 * One usage report for the provider meter (section 10.10). Written in the
 * settle transaction and sent after the commit, with retries.
 */
export const paygUsageReports = pgTable(
  "payg_usage_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => billingAccounts.id, { onDelete: "restrict" }),
    /** The meter event identifier, for example `job:<id>:settle`. */
    identifier: text("identifier").notNull(),
    credits: bigint("credits", { mode: "number" }).notNull(),
    /** Set when the provider accepted the event. */
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    providerEventOk: boolean("provider_event_ok").notNull().default(false),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("payg_usage_reports_identifier_idx").on(table.identifier),
    index("payg_usage_reports_pending_idx")
      .on(table.createdAt)
      .where(sql`${table.providerEventOk} = false`),
    index("payg_usage_reports_account_created_idx").on(
      table.accountId,
      table.createdAt,
    ),
    check("payg_usage_reports_credits_positive", sql`${table.credits} > 0`),
    check("payg_usage_reports_attempts_positive", sql`${table.attempts} >= 0`),
    check(
      "payg_usage_reports_ok_has_reported_at",
      sql`${table.providerEventOk} = false OR ${table.reportedAt} IS NOT NULL`,
    ),
    check(
      "payg_usage_reports_error_length",
      sql`${table.lastError} IS NULL OR char_length(${table.lastError}) <= 1000`,
    ),
  ],
);

/** A provider invoice that charges pay-as-you-go debt (section 10.10). */
export const paygInvoices = pgTable(
  "payg_invoices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => billingAccounts.id, { onDelete: "restrict" }),
    providerInvoiceId: text("provider_invoice_id").notNull(),
    credits: bigint("credits", { mode: "number" }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    status: paygInvoiceStatus("status").notNull(),
    reason: paygInvoiceReason("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("payg_invoices_provider_invoice_idx").on(
      table.providerInvoiceId,
    ),
    index("payg_invoices_account_created_idx").on(
      table.accountId,
      table.createdAt,
    ),
    check("payg_invoices_credits_positive", sql`${table.credits} >= 0`),
    check("payg_invoices_amount_positive", sql`${table.amountCents} >= 0`),
    check(
      "payg_invoices_paid_has_at",
      sql`${table.status} <> 'paid' OR ${table.paidAt} IS NOT NULL`,
    ),
  ],
);

/**
 * Daily quota counters (section 11). `window_start` is 00:00 UTC of the day.
 * Rows older than 35 days are deleted.
 */
export const billingUsageCounters = pgTable(
  "billing_usage_counters",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => billingAccounts.id, { onDelete: "cascade" }),
    /** For example `mcp.tool_calls`. */
    meterKey: text("meter_key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [table.accountId, table.meterKey, table.windowStart],
    }),
    index("billing_usage_counters_window_start_idx").on(table.windowStart),
    check("billing_usage_counters_count_positive", sql`${table.count} >= 0`),
  ],
);

/**
 * Provider webhook events, stored before processing against replays
 * (section 14.1). Kept 90 days.
 */
export const billingProviderEvents = pgTable(
  "billing_provider_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    status: billingProviderEventStatus("status").notNull().default("received"),
    error: text("error"),
  },
  (table) => [
    uniqueIndex("billing_provider_events_provider_event_idx").on(
      table.provider,
      table.eventId,
    ),
    index("billing_provider_events_received_idx").on(table.receivedAt),
    check(
      "billing_provider_events_error_length",
      sql`${table.error} IS NULL OR char_length(${table.error}) <= 1000`,
    ),
  ],
);

/**
 * The `listEventsSince` cursor of the sync job (section 14.3), one row for
 * each provider. Null starts from the beginning of the provider's window.
 */
export const billingSyncState = pgTable("billing_sync_state", {
  provider: text("provider").primaryKey(),
  cursor: text("cursor"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
