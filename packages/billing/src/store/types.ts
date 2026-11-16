import type { ActionKey, PlanKey } from "../catalog/keys";
import type { PicoUsd } from "../credits/usd";

/** Rows of the billing tables (spec section 16.1), as the store returns them. Credits are integers. */

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export type OwnerKind = "user" | "team";

/** Why AI features pause on an account apart from credits (spec 10.10 and 10.4). */
export type AiPausedReason = "payment_failed" | "dispute";

export interface BillingAccount {
  readonly id: string;
  readonly ownerKind: OwnerKind;
  /** Null after the owner is deleted (spec 16.3). */
  readonly ownerId: string | null;
  readonly provider: string | null;
  readonly providerCustomerId: string | null;
  /** A cache of the effective plan. Entitlements compute the real one. */
  readonly planKey: PlanKey;
  /** Every write to the account row increments it. */
  readonly stateVersion: number;
  readonly flaggedAt: Date | null;
  readonly paygEnabled: boolean;
  readonly paygMonthlyLimitCents: number;
  readonly aiPausedReason: AiPausedReason | null;
  /**
   * The account's cap for each metered action (`PUT /billing/accounts/:id/caps`).
   * spec: section 16.1 has no column for it; the db agent stores it (for example a jsonb column).
   */
  readonly actionCaps: Readonly<Partial<Record<ActionKey, number>>>;
  /**
   * The account's Checkout that may still be paid (migration 0048), so two
   * tabs or a retry never open two Checkouts, and so never two subscriptions.
   * Null when there is none.
   */
  readonly openCheckout: OpenCheckout | null;
  /**
   * The start of the last allowance window whose monthly pay-as-you-go sweep
   * ran (spec 10.10 step 6, migration 0048). The sweep catches up on any
   * window after it, so a missed cron tick never skips a month.
   */
  readonly paygSweptWindowStart: Date | null;
  readonly createdAt: Date;
}

export interface OpenCheckout {
  /** Null while a request creates the Checkout: a second request waits for it (409 `checkout_in_progress`). */
  readonly checkoutId: string | null;
  readonly priceKey: string;
  /** The Checkout expiry, or the end of the creation lease while `checkoutId` is null. */
  readonly expiresAt: Date;
}

export type AccountPatch = Partial<
  Pick<
    BillingAccount,
    | "provider"
    | "providerCustomerId"
    | "planKey"
    | "flaggedAt"
    | "paygEnabled"
    | "paygMonthlyLimitCents"
    | "aiPausedReason"
    | "actionCaps"
    | "ownerId"
    | "openCheckout"
    | "paygSweptWindowStart"
  >
>;

/** Provider subscription statuses, normalized to the Stripe names (spec 9.1). */
export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "incomplete",
  "incomplete_expired",
  "canceled",
  "unpaid",
  "paused",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** The mirror of the provider subscription. Only `syncCustomer` writes it. */
export interface SubscriptionRecord {
  readonly accountId: string;
  readonly provider: string;
  readonly providerSubscriptionId: string;
  readonly priceKey: string;
  /** The plan the provider names (for example `product.metadata.doxa_plan`), used when the price key is not in the catalog. */
  readonly planKey: PlanKey | null;
  readonly status: SubscriptionStatus;
  readonly billingAnchor: Date;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly cancelAtPeriodEnd: boolean;
  readonly trialEnd: Date | null;
  /**
   * When the subscription entered `past_due`. The D5 grace period counts from here.
   * spec: section 16.1 has no column for it; the db agent adds one (for example `past_due_since`).
   */
  readonly pastDueSince: Date | null;
  readonly syncedAt: Date;
}

export interface OverrideRecord {
  readonly id: string;
  readonly accountId: string;
  /** `plan`, a feature key or a limit key. */
  readonly key: string;
  readonly value: JsonValue;
  readonly reason: string;
  readonly startsAt: Date | null;
  readonly expiresAt: Date | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

export type GrantKind = "allowance" | "trial" | "promo" | "adjustment";

export interface CreditGrant {
  readonly id: string;
  readonly accountId: string;
  readonly kind: GrantKind;
  readonly amount: number;
  readonly remaining: number;
  readonly startsAt: Date;
  /** Null never expires. */
  readonly expiresAt: Date | null;
  /** Unique for each account: `allowance:<accountId>:<windowStart>`, `trial:<subscriptionId>`, ... */
  readonly sourceRef: string;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export type ReservationStatus = "held" | "settled" | "released";
export type StopReason = "credits_exhausted" | "credit_cap";

export interface Reservation {
  readonly id: string;
  readonly accountId: string;
  readonly actionKey: ActionKey;
  readonly subjectKind: string;
  readonly subjectId: string;
  /** The hold. It grows in steps for a metered action. */
  readonly amount: number;
  readonly baseCredits: number;
  readonly capCredits: number;
  readonly consumedCostPico: PicoUsd;
  readonly markupHundredths: number;
  readonly unitPriceCents: number;
  readonly inFlightMarginCredits: number;
  readonly stopReason: StopReason | null;
  readonly status: ReservationStatus;
  readonly idempotencyKey: string;
  readonly expiresAt: Date;
  readonly settledAmount: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ReservationPatch = Partial<
  Pick<Reservation, "amount" | "consumedCostPico" | "stopReason" | "status" | "settledAmount" | "capCredits">
>;

export interface Accrual {
  readonly reservationId: string;
  readonly callId: string;
  /** Null when the model had no price (logged as `credits.unpriced_model`). */
  readonly costPico: PicoUsd | null;
  readonly createdAt: Date;
}

export const LEDGER_ENTRY_KINDS = ["grant", "debit", "debt", "debt_paid", "release", "expire", "revoke", "adjust", "shortfall"] as const;
export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];

export interface LedgerEntry {
  readonly id: string;
  readonly accountId: string;
  readonly kind: LedgerEntryKind;
  /** Signed. The sum of all entries equals the sum of grant `remaining` minus the open debt. */
  readonly credits: number;
  readonly grantId: string | null;
  readonly reservationId: string | null;
  readonly actionKey: ActionKey | null;
  readonly subjectKind: string | null;
  readonly subjectId: string | null;
  /** Unique in the table. */
  readonly idempotencyKey: string;
  readonly metadata: JsonObject;
  readonly createdAt: Date;
}

export type NewLedgerEntry = Omit<LedgerEntry, "id" | "accountId" | "createdAt">;

export interface PaygUsageReport {
  readonly identifier: string;
  readonly accountId: string;
  readonly credits: number;
  readonly createdAt: Date;
  readonly reportedAt: Date | null;
  readonly attempts: number;
}

export type PaygInvoiceStatus = "draft" | "open" | "paid" | "failed" | "void";
export type PaygInvoiceReason = "threshold" | "sweep" | "pay_now" | "renewal";

export interface PaygInvoice {
  readonly accountId: string;
  readonly providerInvoiceId: string;
  readonly credits: number;
  readonly amountCents: number;
  readonly status: PaygInvoiceStatus;
  readonly reason: PaygInvoiceReason;
  readonly createdAt: Date;
  readonly paidAt: Date | null;
}

export type OfferSlotState = "held" | "claimed" | "released";

export interface OfferSlot {
  readonly offerKey: string;
  readonly accountId: string;
  readonly state: OfferSlotState;
  readonly checkoutSessionId: string | null;
  readonly heldUntil: Date | null;
  readonly claimedAt: Date | null;
  readonly updatedAt: Date;
}

export type ProviderEventStatus = "received" | "processed" | "failed";

export interface ProviderEventRecord {
  readonly provider: string;
  readonly eventId: string;
  readonly type: string;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
  readonly status: ProviderEventStatus;
  readonly error: string | null;
}

export interface UsageCounterKey {
  readonly accountId: string;
  readonly meterKey: string;
  readonly windowStart: Date;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
