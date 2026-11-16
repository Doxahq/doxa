import type { DoxaDb } from "@doxahq/db";
import {
  billingAccounts,
  billingExportClaims,
  billingOffers,
  billingOfferSlots,
  billingOverrides,
  billingProviderEvents,
  billingSubscriptions,
  billingSyncState,
  billingUsageCounters,
  creditAccruals,
  creditGrants,
  creditLedgerEntries,
  creditReservations,
  paygInvoices,
  paygUsageReports,
} from "@doxahq/db/schema";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from "@doxahq/db/orm";

import type { ActionKey, PlanKey } from "../catalog/keys";
import { formatUsd12, parseUsd, type PicoUsd } from "../credits/usd";
import {
  StoreConflictError,
  type AccountState,
  type AccountTx,
  type BillingStore,
  type EnsureAccountInput,
  type OfferTx,
  type ReservationTx,
} from "./store";
import type {
  AccountPatch,
  Accrual,
  AiPausedReason,
  BillingAccount,
  CreditGrant,
  GrantKind,
  JsonObject,
  JsonValue,
  LedgerEntry,
  NewLedgerEntry,
  OfferSlot,
  OverrideRecord,
  OwnerKind,
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
  ExportClaimResult,
} from "./types";

/**
 * The Postgres `BillingStore` (spec 16), over the Drizzle database of
 * `@doxahq/db`. It keeps the atomicity contract of `store.ts`:
 *
 * - Each `with*Lock` is one transaction. It first locks its row
 *   (`SELECT ... FOR NO KEY UPDATE`): the account, the reservation or the
 *   offer. Two lockers of one row run one after the other, as with
 *   `FOR UPDATE`. The weaker mode lets inserts that only reference the row
 *   (quota counters, overrides) run while the lock is held; they take
 *   `FOR KEY SHARE` for their foreign key, which `FOR UPDATE` would block.
 * - Lock order is account, then reservation. A reservation transaction never
 *   touches the account row.
 * - Single-statement methods use `INSERT ... ON CONFLICT` or a conditional
 *   `UPDATE ... RETURNING`.
 * - A unique (23505) or check (23514) violation throws `StoreConflictError`;
 *   the transaction rolls back.
 *
 * Mapping:
 * - USD costs are `numeric(24, 12)`. They go to SQL as decimal text from
 *   `formatUsd12` and come back as text through `parseUsd`, so they never pass
 *   through a JS float.
 * - The markup is the integer `markup_hundredths`.
 * - `ownerKind`/`ownerId` map to `owner_user_id` or `owner_team_id`.
 * - A null `provider` is stored as `none` (the column is required).
 * - Billing IDs are uuids. A lookup by an ID that is not a uuid finds nothing.
 */
export class PostgresBillingStore implements BillingStore {
  constructor(private readonly db: DoxaDb) {}

  // Accounts -----------------------------------------------------------------

  async ensureAccount(input: EnsureAccountInput): Promise<BillingAccount> {
    return guard(async () => {
      if (input.ownerKind === "team" && !isUuid(input.ownerId)) throw new StoreConflictError(`Team ID ${input.ownerId} is not a uuid.`);
      const [inserted] = await this.db
        .insert(billingAccounts)
        .values({
          ownerKind: input.ownerKind,
          ownerUserId: input.ownerKind === "user" ? input.ownerId : null,
          ownerTeamId: input.ownerKind === "team" ? input.ownerId : null,
          provider: NO_PROVIDER,
          planKey: input.planKey,
          stateVersion: 1,
          paygEnabled: input.paygEnabled,
          paygMonthlyLimitCents: input.paygMonthlyLimitCents,
          actionCaps: {},
          openCheckoutId: null,
          openCheckoutPriceKey: null,
          openCheckoutExpiresAt: null,
          paygSweptWindowStart: null,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) return toAccount(inserted);
      const existing = await this.findAccountByOwner(input.ownerKind, input.ownerId);
      if (!existing) throw new StoreConflictError(`Billing account for ${input.ownerKind} ${input.ownerId} conflicts with another row.`);
      return existing;
    });
  }

  async getAccount(accountId: string): Promise<BillingAccount | null> {
    if (!isUuid(accountId)) return null;
    const [row] = await this.db.select().from(billingAccounts).where(eq(billingAccounts.id, accountId));
    return row ? toAccount(row) : null;
  }

  async findAccountByOwner(ownerKind: OwnerKind, ownerId: string): Promise<BillingAccount | null> {
    if (ownerKind === "team" && !isUuid(ownerId)) return null;
    const column = ownerKind === "user" ? billingAccounts.ownerUserId : billingAccounts.ownerTeamId;
    const [row] = await this.db
      .select()
      .from(billingAccounts)
      .where(and(eq(billingAccounts.ownerKind, ownerKind), eq(column, ownerId)));
    return row ? toAccount(row) : null;
  }

  async findAccountByProviderCustomer(provider: string, customerId: string): Promise<BillingAccount | null> {
    const [row] = await this.db
      .select()
      .from(billingAccounts)
      .where(and(eq(billingAccounts.provider, provider), eq(billingAccounts.providerCustomerId, customerId)));
    return row ? toAccount(row) : null;
  }

  async listAccountIdsBySubscriptionStatus(statuses: readonly SubscriptionStatus[]): Promise<string[]> {
    if (statuses.length === 0) return [];
    const rows = await this.db
      .select({ accountId: billingSubscriptions.accountId })
      .from(billingSubscriptions)
      .where(inArray(billingSubscriptions.status, [...statuses]))
      .orderBy(asc(billingSubscriptions.accountId));
    return rows.map((row) => row.accountId);
  }

  async loadAccountState(accountId: string): Promise<AccountState | null> {
    if (!isUuid(accountId)) return null;
    // One snapshot, so the account and its subscription agree.
    return this.db.transaction(
      async (tx) => {
        const [account] = await tx.select().from(billingAccounts).where(eq(billingAccounts.id, accountId));
        if (!account) return null;
        const [subscription] = await tx.select().from(billingSubscriptions).where(eq(billingSubscriptions.accountId, accountId));
        const overrides = await selectOverrides(tx, accountId);
        return { account: toAccount(account), subscription: subscription ? toSubscription(subscription) : null, overrides };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async getSubscription(accountId: string): Promise<SubscriptionRecord | null> {
    if (!isUuid(accountId)) return null;
    return selectSubscription(this.db, accountId);
  }

  async listOverrides(accountId: string): Promise<OverrideRecord[]> {
    if (!isUuid(accountId)) return [];
    return selectOverrides(this.db, accountId);
  }

  async insertOverride(input: Omit<OverrideRecord, "id" | "createdAt">, now: Date): Promise<OverrideRecord> {
    return guard(async () => {
      requireUuid(input.accountId, "Billing account");
      const [row] = await this.db
        .insert(billingOverrides)
        .values({
          accountId: input.accountId,
          key: input.key,
          value: input.value,
          reason: input.reason,
          startsAt: input.startsAt,
          expiresAt: input.expiresAt,
          createdBy: input.createdBy,
          createdAt: now,
        })
        .returning();
      return toOverride(one(row, "override"));
    });
  }

  // Transactions -------------------------------------------------------------

  async withAccountLock<T>(accountId: string, now: Date, fn: (tx: AccountTx) => Promise<T>): Promise<T> {
    requireUuid(accountId, "Billing account");
    return guard(() =>
      this.db.transaction(async (tx) => {
        const [row] = await tx.select().from(billingAccounts).where(eq(billingAccounts.id, accountId)).for("no key update");
        if (!row) throw new StoreConflictError(`Billing account ${accountId} does not exist.`);
        return fn(new PgAccountTx(tx, toAccount(row), now));
      }),
    );
  }

  async withReservationLock<T>(reservationId: string, now: Date, fn: (tx: ReservationTx) => Promise<T>): Promise<T> {
    requireUuid(reservationId, "Reservation");
    return guard(() =>
      this.db.transaction(async (tx) => {
        const [row] = await tx.select().from(creditReservations).where(eq(creditReservations.id, reservationId)).for("no key update");
        if (!row) throw new StoreConflictError(`Reservation ${reservationId} does not exist.`);
        return fn(new PgReservationTx(tx, toReservation(row), now));
      }),
    );
  }

  async withOfferLock<T>(offerKey: string, now: Date, fn: (tx: OfferTx) => Promise<T>): Promise<T> {
    return guard(() =>
      this.db.transaction(async (tx) => {
        // `max_accounts` stays null until the catalog sync writes it; the catalog is the limit.
        await tx.insert(billingOffers).values({ offerKey, createdAt: now, updatedAt: now }).onConflictDoNothing();
        await tx.select({ offerKey: billingOffers.offerKey }).from(billingOffers).where(eq(billingOffers.offerKey, offerKey)).for("no key update");
        return fn(new PgOfferTx(tx, offerKey, now));
      }),
    );
  }

  // Reads ---------------------------------------------------------------------

  async getReservation(reservationId: string): Promise<Reservation | null> {
    if (!isUuid(reservationId)) return null;
    const [row] = await this.db.select().from(creditReservations).where(eq(creditReservations.id, reservationId));
    return row ? toReservation(row) : null;
  }

  async findReservationByKey(idempotencyKey: string): Promise<Reservation | null> {
    const [row] = await this.db.select().from(creditReservations).where(eq(creditReservations.idempotencyKey, idempotencyKey));
    return row ? toReservation(row) : null;
  }

  async findReservationBySubject(subjectKind: string, subjectId: string): Promise<Reservation | null> {
    const [row] = await this.db
      .select()
      .from(creditReservations)
      .where(and(eq(creditReservations.subjectKind, subjectKind), eq(creditReservations.subjectId, subjectId)))
      .orderBy(desc(creditReservations.createdAt), desc(creditReservations.updatedAt))
      .limit(1);
    return row ? toReservation(row) : null;
  }

  async listReservationsBySubject(subjectKind: string, subjectId: string): Promise<Reservation[]> {
    const rows = await this.db
      .select()
      .from(creditReservations)
      .where(and(eq(creditReservations.subjectKind, subjectKind), eq(creditReservations.subjectId, subjectId)))
      .orderBy(asc(creditReservations.createdAt), asc(creditReservations.updatedAt));
    return rows.map(toReservation);
  }

  async listReservations(filter: { status: ReservationStatus; createdBefore?: Date; limit?: number }): Promise<Reservation[]> {
    const conditions: SQL[] = [eq(creditReservations.status, filter.status)];
    if (filter.createdBefore) conditions.push(lt(creditReservations.createdAt, filter.createdBefore));
    const query = this.db
      .select()
      .from(creditReservations)
      .where(and(...conditions))
      .orderBy(asc(creditReservations.createdAt), asc(creditReservations.id));
    const rows = filter.limit === undefined ? await query : await query.limit(filter.limit);
    return rows.map(toReservation);
  }

  async listGrants(accountId: string): Promise<CreditGrant[]> {
    if (!isUuid(accountId)) return [];
    const rows = await this.db
      .select()
      .from(creditGrants)
      .where(eq(creditGrants.accountId, accountId))
      .orderBy(asc(creditGrants.createdAt), asc(creditGrants.id));
    return rows.map(toGrant);
  }

  async listAccountIdsWithExpiredGrants(now: Date, limit?: number): Promise<string[]> {
    const query = this.db
      .selectDistinct({ accountId: creditGrants.accountId })
      .from(creditGrants)
      .where(and(gt(creditGrants.remaining, 0), isNotNull(creditGrants.expiresAt), lte(creditGrants.expiresAt, now)))
      .orderBy(asc(creditGrants.accountId));
    const rows = limit === undefined ? await query : await query.limit(limit);
    return rows.map((row) => row.accountId);
  }

  async sumDebtCredits(reservationIds: readonly string[]): Promise<number> {
    const ids = reservationIds.filter(isUuid);
    if (ids.length === 0) return 0;
    // `credit_ledger_entries_reservation_idx` serves this read. Debt entries are negative.
    const [row] = await this.db
      .select({ total: sql<string | null>`coalesce(sum(-${creditLedgerEntries.credits}), 0)` })
      .from(creditLedgerEntries)
      .where(and(eq(creditLedgerEntries.kind, "debt"), inArray(creditLedgerEntries.reservationId, ids)));
    return Number(row?.total ?? 0);
  }

  async listLedgerEntries(accountId: string, page: { limit: number; cursor?: string | null }): Promise<Page<LedgerEntry>> {
    if (!isUuid(accountId)) return { items: [], nextCursor: null };
    const conditions: SQL[] = [eq(creditLedgerEntries.accountId, accountId)];
    if (page.cursor) {
      const before = Number(page.cursor);
      if (!Number.isSafeInteger(before)) return { items: [], nextCursor: null };
      conditions.push(lt(creditLedgerEntries.sequence, before));
    }
    const rows = await this.db
      .select()
      .from(creditLedgerEntries)
      .where(and(...conditions))
      .orderBy(desc(creditLedgerEntries.sequence))
      .limit(page.limit + 1);
    const items = rows.slice(0, page.limit);
    const last = items.at(-1);
    return { items: items.map(toEntry), nextCursor: rows.length > page.limit && last ? String(last.sequence) : null };
  }

  // Quotas -------------------------------------------------------------------

  async incrementUsageCounter(key: UsageCounterKey): Promise<number> {
    requireUuid(key.accountId, "Billing account");
    return guard(async () => {
      const [row] = await this.db
        .insert(billingUsageCounters)
        .values({ accountId: key.accountId, meterKey: key.meterKey, windowStart: key.windowStart, count: 1 })
        .onConflictDoUpdate({
          target: [billingUsageCounters.accountId, billingUsageCounters.meterKey, billingUsageCounters.windowStart],
          set: { count: sql`${billingUsageCounters.count} + 1` },
        })
        .returning({ count: billingUsageCounters.count });
      return one(row, "usage counter").count;
    });
  }

  async readUsageCounter(key: UsageCounterKey): Promise<number> {
    if (!isUuid(key.accountId)) return 0;
    const [row] = await this.db
      .select({ count: billingUsageCounters.count })
      .from(billingUsageCounters)
      .where(
        and(
          eq(billingUsageCounters.accountId, key.accountId),
          eq(billingUsageCounters.meterKey, key.meterKey),
          eq(billingUsageCounters.windowStart, key.windowStart),
        ),
      );
    return row?.count ?? 0;
  }

  async claimExport(input: { accountId: string; now: Date; windowMs: number }): Promise<ExportClaimResult> {
    requireUuid(input.accountId, "Billing account");
    const at = new Date(input.now);
    const cutoff = new Date(at.getTime() - input.windowMs);
    return guard(async () => {
      const [row] = await this.db
        .insert(billingExportClaims)
        .values({ accountId: input.accountId, lastExportAt: at, previousExportAt: null, updatedAt: at })
        .onConflictDoUpdate({
          target: billingExportClaims.accountId,
          set: {
            previousExportAt: sql`${billingExportClaims.lastExportAt}`,
            lastExportAt: at,
            updatedAt: at,
          },
          setWhere: or(isNull(billingExportClaims.lastExportAt), lte(billingExportClaims.lastExportAt, cutoff)),
        })
        .returning({ lastExportAt: billingExportClaims.lastExportAt });
      if (row) return { claimed: true as const, at };
      const lastExportAt = await this.readLastExport(input.accountId);
      // A refund can clear the row between the two statements: then the
      // window is open, but this claim stays denied. The client asks again.
      return { claimed: false as const, lastExportAt: lastExportAt ?? at };
    });
  }

  async readLastExport(accountId: string): Promise<Date | null> {
    if (!isUuid(accountId)) return null;
    const [row] = await this.db
      .select({ lastExportAt: billingExportClaims.lastExportAt })
      .from(billingExportClaims)
      .where(eq(billingExportClaims.accountId, accountId));
    return row?.lastExportAt ?? null;
  }

  async releaseExport(input: { accountId: string; at: Date }): Promise<void> {
    if (!isUuid(input.accountId)) return;
    await guard(async () => {
      await this.db
        .update(billingExportClaims)
        .set({
          lastExportAt: sql`${billingExportClaims.previousExportAt}`,
          previousExportAt: null,
          updatedAt: sql`now()`,
        })
        .where(and(eq(billingExportClaims.accountId, input.accountId), eq(billingExportClaims.lastExportAt, input.at)));
    });
  }

  // Offers -------------------------------------------------------------------

  async findOfferSlotByCheckout(checkoutSessionId: string): Promise<OfferSlot | null> {
    const [row] = await this.db
      .select()
      .from(billingOfferSlots)
      .where(eq(billingOfferSlots.checkoutSessionId, checkoutSessionId))
      .orderBy(desc(billingOfferSlots.updatedAt))
      .limit(1);
    return row ? toSlot(row) : null;
  }

  async getOfferSlot(offerKey: string, accountId: string): Promise<OfferSlot | null> {
    if (!isUuid(accountId)) return null;
    return selectSlot(this.db, offerKey, accountId);
  }

  async countOfferTaken(offerKey: string, now: Date): Promise<number> {
    return countTakenSlots(this.db, offerKey, now);
  }

  async listExpiredOfferHolds(now: Date): Promise<OfferSlot[]> {
    const rows = await this.db
      .select()
      .from(billingOfferSlots)
      .where(and(eq(billingOfferSlots.state, "held"), isNotNull(billingOfferSlots.heldUntil), lte(billingOfferSlots.heldUntil, now)))
      .orderBy(asc(billingOfferSlots.heldUntil));
    return rows.map(toSlot);
  }

  // Provider events ------------------------------------------------------------

  async claimProviderEvent(input: { provider: string; eventId: string; type: string; now: Date; staleBefore: Date }): Promise<"new" | "retry" | "duplicate"> {
    const [row] = await this.db
      .insert(billingProviderEvents)
      .values({ provider: input.provider, eventId: input.eventId, type: input.type, receivedAt: input.now, status: "received" })
      .onConflictDoUpdate({
        target: [billingProviderEvents.provider, billingProviderEvents.eventId],
        set: { status: "received", receivedAt: input.now, error: null },
        setWhere: or(
          eq(billingProviderEvents.status, "failed"),
          and(eq(billingProviderEvents.status, "received"), lt(billingProviderEvents.receivedAt, input.staleBefore)),
        ),
      })
      // `xmax = 0` only for a row this statement inserted.
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    if (!row) return "duplicate";
    return row.inserted ? "new" : "retry";
  }

  async completeProviderEvent(input: {
    provider: string;
    eventId: string;
    status: Exclude<ProviderEventStatus, "received">;
    error: string | null;
    now: Date;
  }): Promise<void> {
    await this.db
      .update(billingProviderEvents)
      .set({ status: input.status, error: input.error === null ? null : input.error.slice(0, 1000), processedAt: input.now })
      .where(and(eq(billingProviderEvents.provider, input.provider), eq(billingProviderEvents.eventId, input.eventId)));
  }

  async getProviderEvent(provider: string, eventId: string): Promise<ProviderEventRecord | null> {
    const [row] = await this.db
      .select()
      .from(billingProviderEvents)
      .where(and(eq(billingProviderEvents.provider, provider), eq(billingProviderEvents.eventId, eventId)));
    return row
      ? {
          provider: row.provider,
          eventId: row.eventId,
          type: row.type,
          receivedAt: row.receivedAt,
          processedAt: row.processedAt,
          status: row.status,
          error: row.error,
        }
      : null;
  }

  async getSyncCursor(provider: string): Promise<string | null> {
    const [row] = await this.db.select({ cursor: billingSyncState.cursor }).from(billingSyncState).where(eq(billingSyncState.provider, provider));
    return row?.cursor ?? null;
  }

  async setSyncCursor(provider: string, cursor: string | null, now: Date): Promise<void> {
    await this.db
      .insert(billingSyncState)
      .values({ provider, cursor, updatedAt: now })
      .onConflictDoUpdate({ target: billingSyncState.provider, set: { cursor, updatedAt: now } });
  }

  // Pay-as-you-go ----------------------------------------------------------------

  async listPendingUsageReports(limit: number): Promise<PaygUsageReport[]> {
    const rows = await this.db
      .select()
      .from(paygUsageReports)
      .where(isNull(paygUsageReports.reportedAt))
      .orderBy(asc(paygUsageReports.createdAt), asc(paygUsageReports.id))
      .limit(limit);
    return rows.map(toUsageReport);
  }

  async markUsageReportSent(identifier: string, now: Date): Promise<void> {
    await this.db
      .update(paygUsageReports)
      .set({ reportedAt: now, providerEventOk: true, attempts: sql`${paygUsageReports.attempts} + 1` })
      .where(and(eq(paygUsageReports.identifier, identifier), isNull(paygUsageReports.reportedAt)));
  }

  async markUsageReportFailed(identifier: string): Promise<void> {
    await this.db
      .update(paygUsageReports)
      .set({ attempts: sql`${paygUsageReports.attempts} + 1` })
      .where(eq(paygUsageReports.identifier, identifier));
  }

  async getPaygInvoice(providerInvoiceId: string): Promise<PaygInvoice | null> {
    const [row] = await this.db.select().from(paygInvoices).where(eq(paygInvoices.providerInvoiceId, providerInvoiceId));
    return row ? toInvoice(row) : null;
  }

  async listPaygInvoices(accountId: string): Promise<PaygInvoice[]> {
    if (!isUuid(accountId)) return [];
    return selectInvoices(this.db, accountId);
  }
}

/** The Postgres store over the Drizzle database of `@doxahq/db` (`createDb(env)`). */
export function createPostgresBillingStore(db: DoxaDb): BillingStore {
  return new PostgresBillingStore(db);
}

// Transaction handles -----------------------------------------------------------

type PgTx = Parameters<Parameters<DoxaDb["transaction"]>[0]>[0];
type Executor = DoxaDb | PgTx;

class PgAccountTx implements AccountTx {
  constructor(
    private readonly tx: PgTx,
    private current: BillingAccount,
    readonly now: Date,
  ) {}

  get account(): BillingAccount {
    return this.current;
  }

  private get accountId(): string {
    return this.current.id;
  }

  async updateAccount(patch: AccountPatch): Promise<BillingAccount> {
    const set: Partial<typeof billingAccounts.$inferInsert> = {};
    if (patch.provider !== undefined) set.provider = patch.provider ?? NO_PROVIDER;
    if (patch.providerCustomerId !== undefined) set.providerCustomerId = patch.providerCustomerId;
    if (patch.planKey !== undefined) set.planKey = patch.planKey;
    if (patch.flaggedAt !== undefined) set.flaggedAt = patch.flaggedAt;
    if (patch.paygEnabled !== undefined) set.paygEnabled = patch.paygEnabled;
    if (patch.paygMonthlyLimitCents !== undefined) set.paygMonthlyLimitCents = patch.paygMonthlyLimitCents;
    if (patch.aiPausedReason !== undefined) set.aiPausedReason = patch.aiPausedReason;
    if (patch.actionCaps !== undefined) set.actionCaps = { ...patch.actionCaps } as Record<string, number>;
    if (patch.openCheckout !== undefined) {
      set.openCheckoutId = patch.openCheckout?.checkoutId ?? null;
      set.openCheckoutPriceKey = patch.openCheckout?.priceKey ?? null;
      set.openCheckoutExpiresAt = patch.openCheckout?.expiresAt ?? null;
    }
    if (patch.paygSweptWindowStart !== undefined) set.paygSweptWindowStart = patch.paygSweptWindowStart;
    if (patch.ownerId !== undefined) {
      if (this.current.ownerKind === "user") set.ownerUserId = patch.ownerId;
      else set.ownerTeamId = patch.ownerId;
    }
    const [row] = await this.tx
      .update(billingAccounts)
      .set({ ...set, stateVersion: sql`${billingAccounts.stateVersion} + 1`, updatedAt: this.now })
      .where(eq(billingAccounts.id, this.accountId))
      .returning();
    this.current = toAccount(one(row, "account"));
    return this.current;
  }

  async getSubscription(): Promise<SubscriptionRecord | null> {
    return selectSubscription(this.tx, this.accountId);
  }

  async upsertSubscription(record: SubscriptionRecord): Promise<void> {
    if (record.accountId !== this.accountId) throw new StoreConflictError(`Subscription of ${record.accountId} written under the lock of ${this.accountId}.`);
    const values = {
      provider: record.provider,
      providerSubscriptionId: record.providerSubscriptionId,
      priceKey: record.priceKey,
      planKey: record.planKey,
      status: record.status,
      billingAnchor: record.billingAnchor,
      currentPeriodStart: record.currentPeriodStart,
      currentPeriodEnd: record.currentPeriodEnd,
      cancelAtPeriodEnd: record.cancelAtPeriodEnd,
      trialEnd: record.trialEnd,
      pastDueSince: record.pastDueSince,
      syncedAt: record.syncedAt,
      updatedAt: this.now,
    };
    await this.tx
      .insert(billingSubscriptions)
      .values({ ...values, accountId: this.accountId, createdAt: this.now })
      .onConflictDoUpdate({ target: billingSubscriptions.accountId, set: values });
  }

  async listOpenGrants(): Promise<CreditGrant[]> {
    const rows = await this.tx
      .select()
      .from(creditGrants)
      .where(and(eq(creditGrants.accountId, this.accountId), gt(creditGrants.remaining, 0), isNull(creditGrants.revokedAt)))
      .orderBy(asc(creditGrants.createdAt), asc(creditGrants.id));
    return rows.map(toGrant);
  }

  async getGrant(grantId: string): Promise<CreditGrant | null> {
    if (!isUuid(grantId)) return null;
    const [row] = await this.tx
      .select()
      .from(creditGrants)
      .where(and(eq(creditGrants.id, grantId), eq(creditGrants.accountId, this.accountId)));
    return row ? toGrant(row) : null;
  }

  async findGrantBySourceRef(sourceRef: string): Promise<CreditGrant | null> {
    const [row] = await this.tx
      .select()
      .from(creditGrants)
      .where(and(eq(creditGrants.accountId, this.accountId), eq(creditGrants.sourceRef, sourceRef)));
    return row ? toGrant(row) : null;
  }

  async insertGrant(input: { kind: GrantKind; amount: number; startsAt: Date; expiresAt: Date | null; sourceRef: string }): Promise<CreditGrant> {
    if (!Number.isSafeInteger(input.amount) || input.amount < 0) throw new StoreConflictError("Grant amount must be a non-negative integer.");
    const [row] = await this.tx
      .insert(creditGrants)
      .values({
        accountId: this.accountId,
        kind: input.kind,
        amount: input.amount,
        remaining: input.amount,
        startsAt: input.startsAt,
        expiresAt: input.expiresAt,
        sourceRef: input.sourceRef,
        createdAt: this.now,
      })
      .returning();
    return toGrant(one(row, "grant"));
  }

  async updateGrant(grantId: string, patch: { remaining: number; revokedAt?: Date | null }): Promise<void> {
    if (!Number.isSafeInteger(patch.remaining) || patch.remaining < 0) throw new StoreConflictError(`Grant ${grantId} remaining must stay within 0..amount.`);
    requireUuid(grantId, "Grant");
    const [row] = await this.tx
      .update(creditGrants)
      .set({ remaining: patch.remaining, ...(patch.revokedAt === undefined ? {} : { revokedAt: patch.revokedAt }) })
      .where(and(eq(creditGrants.id, grantId), eq(creditGrants.accountId, this.accountId)))
      .returning({ id: creditGrants.id });
    if (!row) throw new StoreConflictError(`Grant ${grantId} does not exist.`);
  }

  async listHeldReservations(): Promise<Reservation[]> {
    const rows = await this.tx
      .select()
      .from(creditReservations)
      .where(and(eq(creditReservations.accountId, this.accountId), eq(creditReservations.status, "held")))
      .orderBy(asc(creditReservations.createdAt), asc(creditReservations.id));
    return rows.map(toReservation);
  }

  async lockReservation(reservationId: string): Promise<Reservation | null> {
    if (!isUuid(reservationId)) return null;
    const [row] = await this.tx
      .select()
      .from(creditReservations)
      .where(and(eq(creditReservations.id, reservationId), eq(creditReservations.accountId, this.accountId)))
      .for("no key update");
    return row ? toReservation(row) : null;
  }

  async findReservationByKey(idempotencyKey: string): Promise<Reservation | null> {
    const [row] = await this.tx
      .select()
      .from(creditReservations)
      .where(and(eq(creditReservations.accountId, this.accountId), eq(creditReservations.idempotencyKey, idempotencyKey)));
    return row ? toReservation(row) : null;
  }

  async insertReservation(input: Omit<Reservation, "id" | "accountId" | "createdAt" | "updatedAt">): Promise<Reservation> {
    const [row] = await this.tx
      .insert(creditReservations)
      .values({
        accountId: this.accountId,
        actionKey: input.actionKey,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        amount: input.amount,
        baseCredits: input.baseCredits,
        capCredits: input.capCredits,
        consumedCostUsd: formatUsd12(input.consumedCostPico),
        markupHundredths: input.markupHundredths,
        unitPriceCents: input.unitPriceCents,
        inFlightMarginCredits: input.inFlightMarginCredits,
        stopReason: input.stopReason,
        status: input.status,
        idempotencyKey: input.idempotencyKey,
        expiresAt: input.expiresAt,
        settledAmount: input.settledAmount,
        closedAt: input.status === "held" ? null : this.now,
        createdAt: this.now,
        updatedAt: this.now,
      })
      .returning();
    return toReservation(one(row, "reservation"));
  }

  async updateReservation(reservationId: string, patch: ReservationPatch): Promise<Reservation> {
    requireUuid(reservationId, "Reservation");
    return updateReservationRow(this.tx, and(eq(creditReservations.id, reservationId), eq(creditReservations.accountId, this.accountId)), reservationId, patch, this.now);
  }

  async findEntry(idempotencyKey: string): Promise<LedgerEntry | null> {
    const [row] = await this.tx
      .select()
      .from(creditLedgerEntries)
      .where(and(eq(creditLedgerEntries.accountId, this.accountId), eq(creditLedgerEntries.idempotencyKey, idempotencyKey)));
    return row ? toEntry(row) : null;
  }

  async insertEntries(entries: readonly NewLedgerEntry[]): Promise<LedgerEntry[]> {
    if (entries.length === 0) return [];
    for (const entry of entries) if (!Number.isSafeInteger(entry.credits)) throw new StoreConflictError("Ledger credits must be integers.");
    const rows = await this.tx
      .insert(creditLedgerEntries)
      .values(
        entries.map((entry) => ({
          accountId: this.accountId,
          kind: entry.kind,
          credits: entry.credits,
          grantId: entry.grantId,
          reservationId: entry.reservationId,
          actionKey: entry.actionKey,
          subjectKind: entry.subjectKind,
          subjectId: entry.subjectId,
          idempotencyKey: entry.idempotencyKey,
          metadata: entry.metadata as Record<string, unknown>,
          createdAt: this.now,
        })),
      )
      .returning();
    return rows.sort((a, b) => a.sequence - b.sequence).map(toEntry);
  }

  async debtSummary(since: Date): Promise<{ openDebt: number; debtSince: number }> {
    const [row] = await this.tx
      .select({
        debt: sql<string>`coalesce(sum(-${creditLedgerEntries.credits}) filter (where ${creditLedgerEntries.kind} = 'debt'), 0)::text`,
        paid: sql<string>`coalesce(sum(${creditLedgerEntries.credits}) filter (where ${creditLedgerEntries.kind} = 'debt_paid'), 0)::text`,
        debtSince: sql<string>`coalesce(sum(-${creditLedgerEntries.credits}) filter (where ${creditLedgerEntries.kind} = 'debt' and ${creditLedgerEntries.createdAt} >= ${since}), 0)::text`,
      })
      .from(creditLedgerEntries)
      .where(eq(creditLedgerEntries.accountId, this.accountId));
    const debt = safeInteger(row?.debt ?? "0");
    const paid = safeInteger(row?.paid ?? "0");
    return { openDebt: Math.max(0, debt - paid), debtSince: safeInteger(row?.debtSince ?? "0") };
  }

  async insertUsageReport(input: { identifier: string; credits: number }): Promise<PaygUsageReport> {
    const [row] = await this.tx
      .insert(paygUsageReports)
      .values({ accountId: this.accountId, identifier: input.identifier, credits: input.credits, createdAt: this.now })
      .returning();
    return toUsageReport(one(row, "usage report"));
  }

  async upsertPaygInvoice(invoice: PaygInvoice): Promise<void> {
    const values = {
      credits: invoice.credits,
      amountCents: invoice.amountCents,
      status: invoice.status,
      reason: invoice.reason,
      paidAt: invoice.paidAt,
      updatedAt: this.now,
    };
    const [row] = await this.tx
      .insert(paygInvoices)
      .values({ ...values, accountId: this.accountId, providerInvoiceId: invoice.providerInvoiceId, createdAt: invoice.createdAt })
      .onConflictDoUpdate({
        target: paygInvoices.providerInvoiceId,
        set: values,
        setWhere: eq(paygInvoices.accountId, this.accountId),
      })
      .returning({ id: paygInvoices.id });
    if (!row) throw new StoreConflictError(`Invoice ${invoice.providerInvoiceId} already belongs to another account.`);
  }

  async getPaygInvoice(providerInvoiceId: string): Promise<PaygInvoice | null> {
    const [row] = await this.tx
      .select()
      .from(paygInvoices)
      .where(and(eq(paygInvoices.accountId, this.accountId), eq(paygInvoices.providerInvoiceId, providerInvoiceId)));
    return row ? toInvoice(row) : null;
  }

  async listPaygInvoices(): Promise<PaygInvoice[]> {
    return selectInvoices(this.tx, this.accountId);
  }
}

class PgReservationTx implements ReservationTx {
  constructor(
    private readonly tx: PgTx,
    private current: Reservation,
    readonly now: Date,
  ) {}

  get reservation(): Reservation {
    return this.current;
  }

  async insertAccrual(input: { callId: string; costPico: PicoUsd | null }): Promise<"inserted" | "duplicate"> {
    const [row] = await this.tx
      .insert(creditAccruals)
      .values({
        callId: input.callId,
        reservationId: this.current.id,
        costUsd: input.costPico === null ? null : formatUsd12(input.costPico),
        createdAt: this.now,
      })
      .onConflictDoNothing({ target: creditAccruals.callId })
      .returning({ callId: creditAccruals.callId });
    return row ? "inserted" : "duplicate";
  }

  async updateReservation(patch: ReservationPatch): Promise<Reservation> {
    this.current = await updateReservationRow(this.tx, eq(creditReservations.id, this.current.id), this.current.id, patch, this.now);
    return this.current;
  }

  async listAccruals(): Promise<Accrual[]> {
    const rows = await this.tx
      .select()
      .from(creditAccruals)
      .where(eq(creditAccruals.reservationId, this.current.id))
      .orderBy(asc(creditAccruals.createdAt), asc(creditAccruals.callId));
    return rows.map((row) => ({
      reservationId: row.reservationId,
      callId: row.callId,
      costPico: row.costUsd === null ? null : picoFromNumeric(row.costUsd),
      createdAt: row.createdAt,
    }));
  }
}

class PgOfferTx implements OfferTx {
  constructor(
    private readonly tx: PgTx,
    readonly offerKey: string,
    readonly now: Date,
  ) {}

  async countTaken(): Promise<number> {
    return countTakenSlots(this.tx, this.offerKey, this.now);
  }

  async getSlot(accountId: string): Promise<OfferSlot | null> {
    if (!isUuid(accountId)) return null;
    return selectSlot(this.tx, this.offerKey, accountId);
  }

  async upsertSlot(slot: Omit<OfferSlot, "offerKey" | "updatedAt">): Promise<OfferSlot> {
    requireUuid(slot.accountId, "Billing account");
    const values = {
      state: slot.state,
      checkoutSessionId: slot.checkoutSessionId,
      heldUntil: slot.heldUntil,
      claimedAt: slot.claimedAt,
      updatedAt: this.now,
    };
    const [row] = await this.tx
      .insert(billingOfferSlots)
      .values({ ...values, offerKey: this.offerKey, accountId: slot.accountId, createdAt: this.now })
      .onConflictDoUpdate({ target: [billingOfferSlots.offerKey, billingOfferSlots.accountId], set: values })
      .returning();
    return toSlot(one(row, "offer slot"));
  }
}

// Shared queries ------------------------------------------------------------------

async function selectSubscription(db: Executor, accountId: string): Promise<SubscriptionRecord | null> {
  const [row] = await db.select().from(billingSubscriptions).where(eq(billingSubscriptions.accountId, accountId));
  return row ? toSubscription(row) : null;
}

async function selectOverrides(db: Executor, accountId: string): Promise<OverrideRecord[]> {
  const rows = await db
    .select()
    .from(billingOverrides)
    .where(eq(billingOverrides.accountId, accountId))
    .orderBy(asc(billingOverrides.createdAt), asc(billingOverrides.id));
  return rows.map(toOverride);
}

async function selectSlot(db: Executor, offerKey: string, accountId: string): Promise<OfferSlot | null> {
  const [row] = await db
    .select()
    .from(billingOfferSlots)
    .where(and(eq(billingOfferSlots.offerKey, offerKey), eq(billingOfferSlots.accountId, accountId)));
  return row ? toSlot(row) : null;
}

async function selectInvoices(db: Executor, accountId: string): Promise<PaygInvoice[]> {
  const rows = await db
    .select()
    .from(paygInvoices)
    .where(eq(paygInvoices.accountId, accountId))
    .orderBy(asc(paygInvoices.createdAt), asc(paygInvoices.id));
  return rows.map(toInvoice);
}

async function updateReservationRow(tx: PgTx, where: SQL | undefined, reservationId: string, patch: ReservationPatch, now: Date): Promise<Reservation> {
  const set: Partial<typeof creditReservations.$inferInsert> = { updatedAt: now };
  if (patch.amount !== undefined) set.amount = patch.amount;
  if (patch.capCredits !== undefined) set.capCredits = patch.capCredits;
  if (patch.consumedCostPico !== undefined) set.consumedCostUsd = formatUsd12(patch.consumedCostPico);
  if (patch.stopReason !== undefined) set.stopReason = patch.stopReason;
  if (patch.settledAmount !== undefined) set.settledAmount = patch.settledAmount;
  if (patch.status !== undefined) {
    set.status = patch.status;
    set.closedAt = patch.status === "held" ? null : now;
  }
  const [row] = await tx.update(creditReservations).set(set).where(where).returning();
  if (!row) throw new StoreConflictError(`Reservation ${reservationId} does not exist.`);
  return toReservation(row);
}

// Row mapping ---------------------------------------------------------------------

/** The `provider` value of an account without a provider customer. */
const NO_PROVIDER = "none";

type AccountRow = typeof billingAccounts.$inferSelect;
type SubscriptionRow = typeof billingSubscriptions.$inferSelect;
type OverrideRow = typeof billingOverrides.$inferSelect;
type GrantRow = typeof creditGrants.$inferSelect;
type ReservationRow = typeof creditReservations.$inferSelect;
type EntryRow = typeof creditLedgerEntries.$inferSelect;
type UsageReportRow = typeof paygUsageReports.$inferSelect;
type InvoiceRow = typeof paygInvoices.$inferSelect;
type SlotRow = typeof billingOfferSlots.$inferSelect;

/** `claimed` slots plus `held` slots whose `held_until` is after `now`. One statement, no lock. */
async function countTakenSlots(db: Executor, offerKey: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(billingOfferSlots)
    .where(
      and(
        eq(billingOfferSlots.offerKey, offerKey),
        or(eq(billingOfferSlots.state, "claimed"), and(eq(billingOfferSlots.state, "held"), gt(billingOfferSlots.heldUntil, now))),
      ),
    );
  return row?.count ?? 0;
}

function toAccount(row: AccountRow): BillingAccount {
  return {
    id: row.id,
    ownerKind: row.ownerKind,
    ownerId: row.ownerKind === "user" ? row.ownerUserId : row.ownerTeamId,
    provider: row.provider === NO_PROVIDER ? null : row.provider,
    providerCustomerId: row.providerCustomerId,
    planKey: row.planKey as PlanKey,
    stateVersion: row.stateVersion,
    flaggedAt: row.flaggedAt,
    paygEnabled: row.paygEnabled,
    paygMonthlyLimitCents: row.paygMonthlyLimitCents,
    aiPausedReason: row.aiPausedReason as AiPausedReason | null,
    actionCaps: (row.actionCaps ?? {}) as Partial<Record<ActionKey, number>>,
    openCheckout:
      row.openCheckoutPriceKey !== null && row.openCheckoutExpiresAt !== null
        ? { checkoutId: row.openCheckoutId, priceKey: row.openCheckoutPriceKey, expiresAt: row.openCheckoutExpiresAt }
        : null,
    paygSweptWindowStart: row.paygSweptWindowStart,
    createdAt: row.createdAt,
  };
}

function toSubscription(row: SubscriptionRow): SubscriptionRecord {
  return {
    accountId: row.accountId,
    provider: row.provider,
    providerSubscriptionId: row.providerSubscriptionId,
    priceKey: row.priceKey,
    planKey: row.planKey as PlanKey | null,
    status: row.status,
    billingAnchor: row.billingAnchor,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    trialEnd: row.trialEnd,
    pastDueSince: row.pastDueSince,
    syncedAt: row.syncedAt,
  };
}

function toOverride(row: OverrideRow): OverrideRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    key: row.key,
    value: row.value as JsonValue,
    reason: row.reason,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

function toGrant(row: GrantRow): CreditGrant {
  return {
    id: row.id,
    accountId: row.accountId,
    kind: row.kind,
    amount: row.amount,
    remaining: row.remaining,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    sourceRef: row.sourceRef,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

function toReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    accountId: row.accountId,
    actionKey: row.actionKey as ActionKey,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    amount: row.amount,
    baseCredits: row.baseCredits,
    capCredits: row.capCredits,
    consumedCostPico: picoFromNumeric(row.consumedCostUsd),
    markupHundredths: row.markupHundredths,
    unitPriceCents: row.unitPriceCents,
    inFlightMarginCredits: row.inFlightMarginCredits,
    stopReason: row.stopReason,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    expiresAt: row.expiresAt,
    settledAmount: row.settledAmount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toEntry(row: EntryRow): LedgerEntry {
  return {
    id: row.id,
    accountId: row.accountId,
    kind: row.kind,
    credits: row.credits,
    grantId: row.grantId,
    reservationId: row.reservationId,
    actionKey: row.actionKey as ActionKey | null,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    idempotencyKey: row.idempotencyKey,
    metadata: (row.metadata ?? {}) as JsonObject,
    createdAt: row.createdAt,
  };
}

function toUsageReport(row: UsageReportRow): PaygUsageReport {
  return {
    identifier: row.identifier,
    accountId: row.accountId,
    credits: row.credits,
    createdAt: row.createdAt,
    reportedAt: row.reportedAt,
    attempts: row.attempts,
  };
}

function toInvoice(row: InvoiceRow): PaygInvoice {
  return {
    accountId: row.accountId,
    providerInvoiceId: row.providerInvoiceId,
    credits: row.credits,
    amountCents: row.amountCents,
    status: row.status,
    reason: row.reason,
    createdAt: row.createdAt,
    paidAt: row.paidAt,
  };
}

function toSlot(row: SlotRow): OfferSlot {
  return {
    offerKey: row.offerKey,
    accountId: row.accountId,
    state: row.state,
    checkoutSessionId: row.checkoutSessionId,
    heldUntil: row.heldUntil,
    claimedAt: row.claimedAt,
    updatedAt: row.updatedAt,
  };
}

// Helpers -------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID.test(value);
}

function requireUuid(value: string, what: string): void {
  if (!isUuid(value)) throw new StoreConflictError(`${what} ${value} does not exist.`);
}

/** A `numeric(24, 12)` value, read as text, in picodollars. */
function picoFromNumeric(text: string): PicoUsd {
  const value = parseUsd(text);
  if (value === null) throw new StoreConflictError(`Stored USD amount ${text} is not valid.`);
  return value;
}

function safeInteger(text: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new StoreConflictError(`Stored credit sum ${text} is not a safe integer.`);
  return value;
}

function one<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new StoreConflictError(`The ${what} write returned no row.`);
  return row;
}

/** Postgres error codes that mean a unique or check constraint was violated. */
const CONFLICT_CODES = new Set(["23505", "23514"]);

function pgErrorCode(error: unknown): string | null {
  for (let current: unknown = error, depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Runs `fn` and turns a unique or check violation into `StoreConflictError`. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof StoreConflictError) throw error;
    const code = pgErrorCode(error);
    if (code && CONFLICT_CODES.has(code)) {
      const detail = (error as { cause?: { constraint?: string; detail?: string } }).cause;
      throw new StoreConflictError(`Billing store conflict (${code}${detail?.constraint ? ` on ${detail.constraint}` : ""}).`, { cause: error });
    }
    throw error;
  }
}
