import type { PlanKey } from "../catalog/keys";
import type { PicoUsd } from "../credits/usd";
import type {
  AccountPatch,
  Accrual,
  BillingAccount,
  CreditGrant,
  GrantKind,
  LedgerEntry,
  NewLedgerEntry,
  OfferSlot,
  OverrideRecord,
  OwnerKind,
  ExportClaimResult,
  Page,
  PaygInvoice,
  PaygUsageReport,
  ProviderEventRecord,
  ProviderEventStatus,
  Reservation,
  ReservationPatch,
  ReservationStatus,
  SubscriptionRecord,
  SubscriptionStatus,
  UsageCounterKey,
} from "./types";

/**
 * The persistence port of billing. Only `@doxahq/billing` writes these tables
 * (spec 16.2). The ledger, meter, offer and quota logic is written once,
 * against this interface, so the Postgres store and the memory store share
 * every rule.
 *
 * ATOMICITY CONTRACT
 *
 * - `now` is the caller's clock reading. The store stamps rows with it and
 *   never reads a clock itself, so tests stay deterministic.
 * - `withAccountLock(accountId, now, fn)` is one database transaction that first
 *   locks the account row (`SELECT ... FROM billing_accounts WHERE id = $1
 *   FOR UPDATE`). Every read and write through the `AccountTx` handle runs in
 *   that transaction. If `fn` throws, nothing it wrote persists. `fn` must
 *   not call the provider or any other network service. Two calls for the
 *   same account run one after the other (spec 10.2 rule 4).
 * - `withReservationLock(reservationId, now, fn)` is one transaction that locks
 *   only the reservation row (`SELECT ... FROM credit_reservations WHERE id =
 *   $1 FOR UPDATE`). The meter uses it for accruals, which must not lock the
 *   account (spec 10.5 step 2). Lock order is always account, then
 *   reservation: an `AccountTx` may lock reservation rows of its account, a
 *   `ReservationTx` never takes the account lock. The memory store may
 *   serialize both on one mutex per account; the outcomes are the same.
 * - `withOfferLock(offerKey, now, fn)` is one transaction that upserts and locks
 *   the `billing_offers` row of the offer (`INSERT ... ON CONFLICT DO
 *   NOTHING`, then `SELECT ... FOR UPDATE`). Two Checkouts for the last slot
 *   run one after the other (spec 7.5 rule 2).
 * - Every other method is a single statement and atomic by itself.
 * - Unique keys (ledger `idempotency_key`, reservation `idempotency_key`,
 *   accrual `call_id`, usage report `identifier`, grant (`account_id`,
 *   `source_ref`), provider event (`provider`, `event_id`)) are enforced by
 *   the store. A violation inside a transaction throws `StoreConflictError`
 *   and rolls the transaction back. Logic checks for an existing row first,
 *   inside the lock, so a conflict means a bug or a cross-account key
 *   collision.
 */
export interface BillingStore {
  /** Upsert on (`owner_kind`, `owner_id`). Concurrent calls return the same row. */
  ensureAccount(input: EnsureAccountInput): Promise<BillingAccount>;
  getAccount(accountId: string): Promise<BillingAccount | null>;
  findAccountByOwner(ownerKind: OwnerKind, ownerId: string): Promise<BillingAccount | null>;
  findAccountByProviderCustomer(provider: string, customerId: string): Promise<BillingAccount | null>;
  /** For the hourly sync job: accounts whose mirrored subscription has one of these statuses. */
  listAccountIdsBySubscriptionStatus(statuses: readonly SubscriptionStatus[]): Promise<string[]>;

  /** One indexed read of the account, its subscription mirror and its override rows (spec 9.2). */
  loadAccountState(accountId: string): Promise<AccountState | null>;
  getSubscription(accountId: string): Promise<SubscriptionRecord | null>;
  listOverrides(accountId: string): Promise<OverrideRecord[]>;
  insertOverride(input: Omit<OverrideRecord, "id" | "createdAt">, now: Date): Promise<OverrideRecord>;

  withAccountLock<T>(accountId: string, now: Date, fn: (tx: AccountTx) => Promise<T>): Promise<T>;
  withReservationLock<T>(reservationId: string, now: Date, fn: (tx: ReservationTx) => Promise<T>): Promise<T>;
  withOfferLock<T>(offerKey: string, now: Date, fn: (tx: OfferTx) => Promise<T>): Promise<T>;

  getReservation(reservationId: string): Promise<Reservation | null>;
  findReservationByKey(idempotencyKey: string): Promise<Reservation | null>;
  /** The newest reservation for a subject (for example the job of `isJobActive`). */
  findReservationBySubject(subjectKind: string, subjectId: string): Promise<Reservation | null>;
  /** Every reservation of a subject, oldest first. A resumed job has one for each admission. */
  listReservationsBySubject(subjectKind: string, subjectId: string): Promise<Reservation[]>;
  /** For the 5-minute cron: held reservations, optionally only those created before a time. */
  listReservations(filter: { status: ReservationStatus; createdBefore?: Date; limit?: number }): Promise<Reservation[]>;

  /** Grants of the account (for reads and the expiry sweep). */
  listGrants(accountId: string): Promise<CreditGrant[]>;
  /** Accounts that have a grant with `remaining > 0` that expired at or before `now`. */
  listAccountIdsWithExpiredGrants(now: Date, limit?: number): Promise<string[]>;
  /** The credits that pay-as-you-go paid (the `debt` entries) for these reservations. 0 for none. */
  sumDebtCredits(reservationIds: readonly string[]): Promise<number>;
  /** Newest first. The cursor is opaque. */
  listLedgerEntries(accountId: string, page: { limit: number; cursor?: string | null }): Promise<Page<LedgerEntry>>;

  /**
   * One statement: `INSERT ... ON CONFLICT (account_id, meter_key, window_start)
   * DO UPDATE SET count = count + 1 RETURNING count`. Returns the new count.
   */
  incrementUsageCounter(key: UsageCounterKey): Promise<number>;
  readUsageCounter(key: UsageCounterKey): Promise<number>;

  /**
   * The rolling docs export window. One statement: `INSERT ... ON CONFLICT
   * (account_id) DO UPDATE SET previous_export_at = last_export_at,
   * last_export_at = now WHERE last_export_at IS NULL OR last_export_at <=
   * now - window`. Two parallel claims of one account can never both pass.
   */
  claimExport(input: { accountId: string; now: Date; windowMs: number }): Promise<ExportClaimResult>;
  /** The time of the last export of the account. Null for none. */
  readLastExport(accountId: string): Promise<Date | null>;
  /**
   * Gives back the claim made at `at`: the row goes back to the export
   * before it. Changes nothing if a newer claim replaced it.
   */
  releaseExport(input: { accountId: string; at: Date }): Promise<void>;

  findOfferSlotByCheckout(checkoutSessionId: string): Promise<OfferSlot | null>;
  getOfferSlot(offerKey: string, accountId: string): Promise<OfferSlot | null>;
  /** Like `OfferTx.countTaken`, as one statement without the lock or the offer row insert (the public offer read). */
  countOfferTaken(offerKey: string, now: Date): Promise<number>;
  /** For the cron: held slots whose `held_until` is at or before `now`. */
  listExpiredOfferHolds(now: Date): Promise<OfferSlot[]>;

  /**
   * Records a webhook or sync event. One statement (insert, or a conditional
   * update for a retry): `new` when inserted; `retry` when the stored event
   * had `failed`, or stayed `received` since before `staleBefore`, and this
   * call took it over; `duplicate` otherwise.
   */
  claimProviderEvent(input: {
    provider: string;
    eventId: string;
    type: string;
    now: Date;
    staleBefore: Date;
  }): Promise<"new" | "retry" | "duplicate">;
  completeProviderEvent(input: {
    provider: string;
    eventId: string;
    status: Exclude<ProviderEventStatus, "received">;
    error: string | null;
    now: Date;
  }): Promise<void>;
  getProviderEvent(provider: string, eventId: string): Promise<ProviderEventRecord | null>;
  /**
   * The `listEventsSince` cursor of the sync job.
   * spec: section 16.1 has no table for it; the db agent adds one (for example `billing_sync_state`).
   */
  getSyncCursor(provider: string): Promise<string | null>;
  setSyncCursor(provider: string, cursor: string | null, now: Date): Promise<void>;

  /** Usage reports not yet accepted by the provider, oldest first. */
  listPendingUsageReports(limit: number): Promise<PaygUsageReport[]>;
  /** Conditional: sets `reported_at` only when it is null. */
  markUsageReportSent(identifier: string, now: Date): Promise<void>;
  /** Increments `attempts`. */
  markUsageReportFailed(identifier: string, now: Date): Promise<void>;
  getPaygInvoice(providerInvoiceId: string): Promise<PaygInvoice | null>;
  listPaygInvoices(accountId: string): Promise<PaygInvoice[]>;
}

export interface AccountState {
  readonly account: BillingAccount;
  readonly subscription: SubscriptionRecord | null;
  readonly overrides: readonly OverrideRecord[];
}

export interface EnsureAccountInput {
  readonly ownerKind: OwnerKind;
  readonly ownerId: string;
  readonly planKey: PlanKey;
  readonly paygEnabled: boolean;
  readonly paygMonthlyLimitCents: number;
  readonly now: Date;
}

/** The handle of one locked account transaction. See the atomicity contract. */
export interface AccountTx {
  /** The account row, read under the lock. `updateAccount` returns the new row. */
  readonly account: BillingAccount;
  readonly now: Date;
  /** Writes the account row and increments `state_version`. */
  updateAccount(patch: AccountPatch): Promise<BillingAccount>;

  getSubscription(): Promise<SubscriptionRecord | null>;
  upsertSubscription(record: SubscriptionRecord): Promise<void>;

  /** Grants with `remaining > 0` and no `revoked_at`, including ones past `expires_at` that no sweep zeroed yet. */
  listOpenGrants(): Promise<CreditGrant[]>;
  getGrant(grantId: string): Promise<CreditGrant | null>;
  findGrantBySourceRef(sourceRef: string): Promise<CreditGrant | null>;
  insertGrant(input: {
    kind: GrantKind;
    amount: number;
    startsAt: Date;
    expiresAt: Date | null;
    sourceRef: string;
  }): Promise<CreditGrant>;
  updateGrant(grantId: string, patch: { remaining: number; revokedAt?: Date | null }): Promise<void>;

  listHeldReservations(): Promise<Reservation[]>;
  /** Reads and row-locks a reservation of this account (`FOR UPDATE`). Null if missing or of another account. */
  lockReservation(reservationId: string): Promise<Reservation | null>;
  findReservationByKey(idempotencyKey: string): Promise<Reservation | null>;
  insertReservation(input: Omit<Reservation, "id" | "accountId" | "createdAt" | "updatedAt">): Promise<Reservation>;
  updateReservation(reservationId: string, patch: ReservationPatch): Promise<Reservation>;

  findEntry(idempotencyKey: string): Promise<LedgerEntry | null>;
  insertEntries(entries: readonly NewLedgerEntry[]): Promise<LedgerEntry[]>;
  /**
   * `openDebt` = credits of `debt` entries not yet cleared by `debt_paid`
   * entries. `debtSince` = credits of `debt` entries created at or after
   * `since` (the pay-as-you-go total of the current window).
   */
  debtSummary(since: Date): Promise<{ openDebt: number; debtSince: number }>;

  insertUsageReport(input: { identifier: string; credits: number }): Promise<PaygUsageReport>;
  upsertPaygInvoice(invoice: PaygInvoice): Promise<void>;
  getPaygInvoice(providerInvoiceId: string): Promise<PaygInvoice | null>;
  listPaygInvoices(): Promise<PaygInvoice[]>;
}

/** The handle of one locked reservation transaction (accruals). */
export interface ReservationTx {
  readonly reservation: Reservation;
  readonly now: Date;
  /** `duplicate` when the call ID exists (`ON CONFLICT (call_id) DO NOTHING`). */
  insertAccrual(input: { callId: string; costPico: PicoUsd | null }): Promise<"inserted" | "duplicate">;
  updateReservation(patch: ReservationPatch): Promise<Reservation>;
  listAccruals(): Promise<Accrual[]>;
}

/** The handle of one locked offer transaction. */
export interface OfferTx {
  readonly offerKey: string;
  readonly now: Date;
  /** `claimed` slots plus `held` slots whose `held_until` is after `now`. */
  countTaken(): Promise<number>;
  getSlot(accountId: string): Promise<OfferSlot | null>;
  upsertSlot(slot: Omit<OfferSlot, "offerKey" | "updatedAt">): Promise<OfferSlot>;
}

/** A unique key was violated. The transaction rolls back. */
export class StoreConflictError extends Error {
  override readonly name = "StoreConflictError";
}
