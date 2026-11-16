import type { PicoUsd } from "../credits/usd";
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
  BillingAccount,
  CreditGrant,
  GrantKind,
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

interface AccountData {
  account: BillingAccount;
  subscription: SubscriptionRecord | null;
  overrides: OverrideRecord[];
  grants: Map<string, CreditGrant>;
  reservations: Map<string, Reservation>;
  accruals: Map<string, Accrual>;
  entries: LedgerEntry[];
  reports: Map<string, PaygUsageReport>;
  invoices: Map<string, PaygInvoice>;
}

/** Runs one function at a time for each key, in call order. */
class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/** Global unique indexes, owned by account, checked when a transaction commits. */
interface UniqueIndexes {
  entryKeys: Map<string, string>;
  reservationKeys: Map<string, string>;
  callIds: Map<string, string>;
  reportIds: Map<string, string>;
  invoiceIds: Map<string, string>;
}

type IndexName = keyof UniqueIndexes;

/**
 * The in-memory `BillingStore` for unit tests. It keeps the atomicity
 * contract of `store.ts`: each lock runs one function at a time per account
 * (or offer), works on a copy, and commits the copy only when the function
 * returns. A throw discards every write of the transaction.
 *
 * Reservation locks use the account mutex: stronger than the Postgres row
 * lock, with the same outcomes.
 */
export class MemoryBillingStore implements BillingStore {
  private readonly accounts = new Map<string, AccountData>();
  private readonly ownerIndex = new Map<string, string>();
  private readonly customerIndex = new Map<string, string>();
  private readonly reservationIndex = new Map<string, string>();
  private readonly unique: UniqueIndexes = {
    entryKeys: new Map(),
    reservationKeys: new Map(),
    callIds: new Map(),
    reportIds: new Map(),
    invoiceIds: new Map(),
  };
  private readonly counters = new Map<string, number>();
  private readonly exportClaims = new Map<string, { last: Date | null; previous: Date | null }>();
  private readonly offerSlots = new Map<string, Map<string, OfferSlot>>();
  private readonly events = new Map<string, ProviderEventRecord>();
  private readonly cursors = new Map<string, string | null>();
  private readonly accountMutex = new KeyedMutex();
  private readonly offerMutex = new KeyedMutex();
  private readonly ensureMutex = new KeyedMutex();
  private nextId = 1;

  private id(prefix: string): string {
    return `${prefix}_${this.nextId++}`;
  }

  private data(accountId: string): AccountData {
    const data = this.accounts.get(accountId);
    if (!data) throw new StoreConflictError(`Billing account ${accountId} does not exist.`);
    return data;
  }

  // Accounts -----------------------------------------------------------------

  async ensureAccount(input: EnsureAccountInput): Promise<BillingAccount> {
    const ownerKey = `${input.ownerKind}:${input.ownerId}`;
    return this.ensureMutex.run(ownerKey, async () => {
      const existing = this.ownerIndex.get(ownerKey);
      if (existing) return this.data(existing).account;
      const account: BillingAccount = {
        id: this.id("acct"),
        ownerKind: input.ownerKind,
        ownerId: input.ownerId,
        provider: null,
        providerCustomerId: null,
        planKey: input.planKey,
        stateVersion: 1,
        flaggedAt: null,
        paygEnabled: input.paygEnabled,
        paygMonthlyLimitCents: input.paygMonthlyLimitCents,
        aiPausedReason: null,
        actionCaps: {},
        openCheckout: null,
        paygSweptWindowStart: null,
        createdAt: input.now,
      };
      this.accounts.set(account.id, {
        account,
        subscription: null,
        overrides: [],
        grants: new Map(),
        reservations: new Map(),
        accruals: new Map(),
        entries: [],
        reports: new Map(),
        invoices: new Map(),
      });
      this.ownerIndex.set(ownerKey, account.id);
      return account;
    });
  }

  async getAccount(accountId: string): Promise<BillingAccount | null> {
    return this.accounts.get(accountId)?.account ?? null;
  }

  async findAccountByOwner(ownerKind: OwnerKind, ownerId: string): Promise<BillingAccount | null> {
    const id = this.ownerIndex.get(`${ownerKind}:${ownerId}`);
    return id ? this.data(id).account : null;
  }

  async findAccountByProviderCustomer(provider: string, customerId: string): Promise<BillingAccount | null> {
    const id = this.customerIndex.get(`${provider}:${customerId}`);
    return id ? this.data(id).account : null;
  }

  async listAccountIdsBySubscriptionStatus(statuses: readonly SubscriptionStatus[]): Promise<string[]> {
    return [...this.accounts.values()]
      .filter((data) => data.subscription && statuses.includes(data.subscription.status))
      .map((data) => data.account.id);
  }

  async loadAccountState(accountId: string): Promise<AccountState | null> {
    const data = this.accounts.get(accountId);
    return data ? { account: data.account, subscription: data.subscription, overrides: [...data.overrides] } : null;
  }

  async getSubscription(accountId: string): Promise<SubscriptionRecord | null> {
    return this.accounts.get(accountId)?.subscription ?? null;
  }

  async listOverrides(accountId: string): Promise<OverrideRecord[]> {
    return [...(this.accounts.get(accountId)?.overrides ?? [])];
  }

  async insertOverride(input: Omit<OverrideRecord, "id" | "createdAt">, now: Date): Promise<OverrideRecord> {
    const row: OverrideRecord = { ...input, id: this.id("ovr"), createdAt: now };
    this.data(input.accountId).overrides.push(row);
    return row;
  }

  // Transactions -------------------------------------------------------------

  async withAccountLock<T>(accountId: string, now: Date, fn: (tx: AccountTx) => Promise<T>): Promise<T> {
    return this.accountMutex.run(accountId, async () => {
      const original = this.data(accountId);
      const work = cloneData(original);
      const staged = new StagedKeys();
      const tx = new MemoryAccountTx(this, work, staged, now);
      const result = await fn(tx);
      this.commit(accountId, original, work, staged);
      return result;
    });
  }

  async withReservationLock<T>(reservationId: string, now: Date, fn: (tx: ReservationTx) => Promise<T>): Promise<T> {
    const accountId = this.reservationIndex.get(reservationId);
    if (!accountId) throw new StoreConflictError(`Reservation ${reservationId} does not exist.`);
    return this.accountMutex.run(accountId, async () => {
      const original = this.data(accountId);
      const work = cloneData(original);
      const staged = new StagedKeys();
      const reservation = work.reservations.get(reservationId);
      if (!reservation) throw new StoreConflictError(`Reservation ${reservationId} does not exist.`);
      const tx = new MemoryReservationTx(this, work, staged, reservation, now);
      const result = await fn(tx);
      this.commit(accountId, original, work, staged);
      return result;
    });
  }

  async withOfferLock<T>(offerKey: string, now: Date, fn: (tx: OfferTx) => Promise<T>): Promise<T> {
    return this.offerMutex.run(offerKey, async () => {
      const original = this.offerSlots.get(offerKey) ?? new Map<string, OfferSlot>();
      const work = new Map([...original].map(([key, slot]) => [key, { ...slot }]));
      const tx: OfferTx = {
        offerKey,
        now,
        countTaken: async () =>
          [...work.values()].filter(
            (slot) => slot.state === "claimed" || (slot.state === "held" && slot.heldUntil !== null && slot.heldUntil > now),
          ).length,
        getSlot: async (accountId) => work.get(accountId) ?? null,
        upsertSlot: async (slot) => {
          const row: OfferSlot = { ...slot, offerKey, updatedAt: now };
          work.set(slot.accountId, row);
          return row;
        },
      };
      const result = await fn(tx);
      this.offerSlots.set(offerKey, work);
      return result;
    });
  }

  /** @internal Checks staged unique keys against other accounts, then swaps in the copy. */
  private commit(accountId: string, original: AccountData, work: AccountData, staged: StagedKeys): void {
    for (const [index, keys] of staged.entries()) {
      for (const key of keys) {
        const owner = this.unique[index].get(key);
        if (owner !== undefined && owner !== accountId) {
          throw new StoreConflictError(`Unique key ${index}=${key} already belongs to another account.`);
        }
      }
    }
    if (work.account.providerCustomerId !== original.account.providerCustomerId && work.account.providerCustomerId) {
      const key = `${work.account.provider}:${work.account.providerCustomerId}`;
      const owner = this.customerIndex.get(key);
      if (owner !== undefined && owner !== accountId) throw new StoreConflictError(`Customer ${key} already belongs to another account.`);
      if (original.account.providerCustomerId) this.customerIndex.delete(`${original.account.provider}:${original.account.providerCustomerId}`);
      this.customerIndex.set(key, accountId);
    }
    for (const [index, keys] of staged.entries()) {
      for (const key of keys) this.unique[index].set(key, accountId);
    }
    for (const id of work.reservations.keys()) this.reservationIndex.set(id, accountId);
    this.accounts.set(accountId, work);
  }

  /** @internal Used by the transaction handles. */
  isKeyTaken(index: IndexName, key: string): boolean {
    return this.unique[index].has(key);
  }

  /** @internal */
  newId(prefix: string): string {
    return this.id(prefix);
  }

  // Reads ---------------------------------------------------------------------

  async getReservation(reservationId: string): Promise<Reservation | null> {
    const accountId = this.reservationIndex.get(reservationId);
    return accountId ? (this.data(accountId).reservations.get(reservationId) ?? null) : null;
  }

  async findReservationByKey(idempotencyKey: string): Promise<Reservation | null> {
    const accountId = this.unique.reservationKeys.get(idempotencyKey);
    if (!accountId) return null;
    return [...this.data(accountId).reservations.values()].find((row) => row.idempotencyKey === idempotencyKey) ?? null;
  }

  async findReservationBySubject(subjectKind: string, subjectId: string): Promise<Reservation | null> {
    let newest: Reservation | null = null;
    for (const data of this.accounts.values()) {
      for (const row of data.reservations.values()) {
        if (row.subjectKind === subjectKind && row.subjectId === subjectId && (!newest || row.createdAt >= newest.createdAt)) newest = row;
      }
    }
    return newest;
  }

  async listReservationsBySubject(subjectKind: string, subjectId: string): Promise<Reservation[]> {
    const rows: Reservation[] = [];
    for (const data of this.accounts.values()) {
      for (const row of data.reservations.values()) {
        if (row.subjectKind === subjectKind && row.subjectId === subjectId) rows.push(row);
      }
    }
    // Stable: rows created at the same time keep their insertion order.
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async listReservations(filter: { status: ReservationStatus; createdBefore?: Date; limit?: number }): Promise<Reservation[]> {
    const rows: Reservation[] = [];
    for (const data of this.accounts.values()) {
      for (const row of data.reservations.values()) {
        if (row.status !== filter.status) continue;
        if (filter.createdBefore && !(row.createdAt < filter.createdBefore)) continue;
        rows.push(row);
      }
    }
    rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return filter.limit === undefined ? rows : rows.slice(0, filter.limit);
  }

  async listGrants(accountId: string): Promise<CreditGrant[]> {
    return [...(this.accounts.get(accountId)?.grants.values() ?? [])];
  }

  async listAccountIdsWithExpiredGrants(now: Date, limit?: number): Promise<string[]> {
    const ids = [...this.accounts.values()]
      .filter((data) => [...data.grants.values()].some((grant) => grant.remaining > 0 && grant.expiresAt !== null && grant.expiresAt <= now))
      .map((data) => data.account.id);
    return limit === undefined ? ids : ids.slice(0, limit);
  }

  async sumDebtCredits(reservationIds: readonly string[]): Promise<number> {
    const ids = new Set(reservationIds);
    let total = 0;
    for (const data of this.accounts.values()) {
      for (const entry of data.entries) {
        if (entry.kind === "debt" && entry.reservationId !== null && ids.has(entry.reservationId)) total -= entry.credits;
      }
    }
    return total;
  }

  async listLedgerEntries(accountId: string, page: { limit: number; cursor?: string | null }): Promise<Page<LedgerEntry>> {
    const all = [...(this.accounts.get(accountId)?.entries ?? [])].reverse();
    const start = page.cursor ? Number(page.cursor) : 0;
    const items = all.slice(start, start + page.limit);
    const next = start + page.limit;
    return { items, nextCursor: next < all.length ? String(next) : null };
  }

  /** Test helper: every ledger entry of the account, oldest first. */
  allLedgerEntries(accountId: string): LedgerEntry[] {
    return [...(this.accounts.get(accountId)?.entries ?? [])];
  }

  /** Test helper: every usage report of the account. */
  allUsageReports(accountId: string): PaygUsageReport[] {
    return [...(this.accounts.get(accountId)?.reports.values() ?? [])];
  }

  /** Test helper: accruals of the account. */
  allAccruals(accountId: string): Accrual[] {
    return [...(this.accounts.get(accountId)?.accruals.values() ?? [])];
  }

  // Quotas -------------------------------------------------------------------

  async incrementUsageCounter(key: UsageCounterKey): Promise<number> {
    const id = counterId(key);
    const count = (this.counters.get(id) ?? 0) + 1;
    this.counters.set(id, count);
    return count;
  }

  async readUsageCounter(key: UsageCounterKey): Promise<number> {
    return this.counters.get(counterId(key)) ?? 0;
  }

  async claimExport(input: { accountId: string; now: Date; windowMs: number }): Promise<ExportClaimResult> {
    const row = this.exportClaims.get(input.accountId);
    if (row?.last && row.last.getTime() > input.now.getTime() - input.windowMs) {
      return { claimed: false, lastExportAt: row.last };
    }
    const at = new Date(input.now);
    this.exportClaims.set(input.accountId, { last: at, previous: row?.last ?? null });
    return { claimed: true, at };
  }

  async readLastExport(accountId: string): Promise<Date | null> {
    return this.exportClaims.get(accountId)?.last ?? null;
  }

  async releaseExport(input: { accountId: string; at: Date }): Promise<void> {
    const row = this.exportClaims.get(input.accountId);
    if (!row?.last || row.last.getTime() !== input.at.getTime()) return;
    this.exportClaims.set(input.accountId, { last: row.previous, previous: null });
  }

  // Offers -------------------------------------------------------------------

  async findOfferSlotByCheckout(checkoutSessionId: string): Promise<OfferSlot | null> {
    for (const slots of this.offerSlots.values()) {
      for (const slot of slots.values()) if (slot.checkoutSessionId === checkoutSessionId) return slot;
    }
    return null;
  }

  async getOfferSlot(offerKey: string, accountId: string): Promise<OfferSlot | null> {
    return this.offerSlots.get(offerKey)?.get(accountId) ?? null;
  }

  async countOfferTaken(offerKey: string, now: Date): Promise<number> {
    return [...(this.offerSlots.get(offerKey)?.values() ?? [])].filter(
      (slot) => slot.state === "claimed" || (slot.state === "held" && slot.heldUntil !== null && slot.heldUntil > now),
    ).length;
  }

  async listExpiredOfferHolds(now: Date): Promise<OfferSlot[]> {
    const rows: OfferSlot[] = [];
    for (const slots of this.offerSlots.values()) {
      for (const slot of slots.values()) if (slot.state === "held" && slot.heldUntil !== null && slot.heldUntil <= now) rows.push(slot);
    }
    return rows;
  }

  // Provider events ------------------------------------------------------------

  async claimProviderEvent(input: { provider: string; eventId: string; type: string; now: Date; staleBefore: Date }): Promise<"new" | "retry" | "duplicate"> {
    const key = `${input.provider}:${input.eventId}`;
    const existing = this.events.get(key);
    if (!existing) {
      this.events.set(key, {
        provider: input.provider,
        eventId: input.eventId,
        type: input.type,
        receivedAt: input.now,
        processedAt: null,
        status: "received",
        error: null,
      });
      return "new";
    }
    const stale = existing.status === "received" && existing.receivedAt < input.staleBefore;
    if (existing.status === "failed" || stale) {
      this.events.set(key, { ...existing, status: "received", receivedAt: input.now, error: null });
      return "retry";
    }
    return "duplicate";
  }

  async completeProviderEvent(input: {
    provider: string;
    eventId: string;
    status: Exclude<ProviderEventStatus, "received">;
    error: string | null;
    now: Date;
  }): Promise<void> {
    const key = `${input.provider}:${input.eventId}`;
    const existing = this.events.get(key);
    if (!existing) return;
    this.events.set(key, { ...existing, status: input.status, error: input.error, processedAt: input.now });
  }

  async getProviderEvent(provider: string, eventId: string): Promise<ProviderEventRecord | null> {
    return this.events.get(`${provider}:${eventId}`) ?? null;
  }

  async getSyncCursor(provider: string): Promise<string | null> {
    return this.cursors.get(provider) ?? null;
  }

  async setSyncCursor(provider: string, cursor: string | null): Promise<void> {
    this.cursors.set(provider, cursor);
  }

  // Pay-as-you-go ----------------------------------------------------------------

  async listPendingUsageReports(limit: number): Promise<PaygUsageReport[]> {
    const rows: PaygUsageReport[] = [];
    for (const data of this.accounts.values()) for (const report of data.reports.values()) if (!report.reportedAt) rows.push(report);
    rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return rows.slice(0, limit);
  }

  async markUsageReportSent(identifier: string, now: Date): Promise<void> {
    this.updateReport(identifier, (report) => (report.reportedAt ? report : { ...report, reportedAt: now, attempts: report.attempts + 1 }));
  }

  async markUsageReportFailed(identifier: string): Promise<void> {
    this.updateReport(identifier, (report) => ({ ...report, attempts: report.attempts + 1 }));
  }

  private updateReport(identifier: string, update: (report: PaygUsageReport) => PaygUsageReport): void {
    const accountId = this.unique.reportIds.get(identifier);
    if (!accountId) return;
    const reports = this.data(accountId).reports;
    const report = reports.get(identifier);
    if (report) reports.set(identifier, update(report));
  }

  async getPaygInvoice(providerInvoiceId: string): Promise<PaygInvoice | null> {
    const accountId = this.unique.invoiceIds.get(providerInvoiceId);
    return accountId ? (this.data(accountId).invoices.get(providerInvoiceId) ?? null) : null;
  }

  async listPaygInvoices(accountId: string): Promise<PaygInvoice[]> {
    return [...(this.accounts.get(accountId)?.invoices.values() ?? [])];
  }
}

class StagedKeys {
  private readonly keys = new Map<IndexName, Set<string>>();

  add(index: IndexName, key: string): void {
    const set = this.keys.get(index) ?? new Set<string>();
    set.add(key);
    this.keys.set(index, set);
  }

  has(index: IndexName, key: string): boolean {
    return this.keys.get(index)?.has(key) ?? false;
  }

  entries(): IterableIterator<[IndexName, Set<string>]> {
    return this.keys.entries();
  }
}

class MemoryAccountTx implements AccountTx {
  constructor(
    private readonly store: MemoryBillingStore,
    private readonly work: AccountData,
    private readonly staged: StagedKeys,
    readonly now: Date,
  ) {}

  get account(): BillingAccount {
    return this.work.account;
  }

  private claim(index: IndexName, key: string, what: string): void {
    if (this.staged.has(index, key) || this.store.isKeyTaken(index, key)) throw new StoreConflictError(`${what} ${key} already exists.`);
    this.staged.add(index, key);
  }

  async updateAccount(patch: AccountPatch): Promise<BillingAccount> {
    this.work.account = { ...this.work.account, ...patch, stateVersion: this.work.account.stateVersion + 1 };
    return this.work.account;
  }

  async getSubscription(): Promise<SubscriptionRecord | null> {
    return this.work.subscription;
  }

  async upsertSubscription(record: SubscriptionRecord): Promise<void> {
    this.work.subscription = record;
  }

  async listOpenGrants(): Promise<CreditGrant[]> {
    return [...this.work.grants.values()].filter((grant) => grant.remaining > 0 && grant.revokedAt === null);
  }

  async getGrant(grantId: string): Promise<CreditGrant | null> {
    return this.work.grants.get(grantId) ?? null;
  }

  async findGrantBySourceRef(sourceRef: string): Promise<CreditGrant | null> {
    return [...this.work.grants.values()].find((grant) => grant.sourceRef === sourceRef) ?? null;
  }

  async insertGrant(input: { kind: GrantKind; amount: number; startsAt: Date; expiresAt: Date | null; sourceRef: string }): Promise<CreditGrant> {
    if (await this.findGrantBySourceRef(input.sourceRef)) throw new StoreConflictError(`Grant ${input.sourceRef} already exists.`);
    if (!Number.isSafeInteger(input.amount) || input.amount < 0) throw new StoreConflictError("Grant amount must be a non-negative integer.");
    const grant: CreditGrant = {
      ...input,
      id: this.store.newId("grant"),
      accountId: this.work.account.id,
      remaining: input.amount,
      revokedAt: null,
      createdAt: this.now,
    };
    this.work.grants.set(grant.id, grant);
    return grant;
  }

  async updateGrant(grantId: string, patch: { remaining: number; revokedAt?: Date | null }): Promise<void> {
    const grant = this.work.grants.get(grantId);
    if (!grant) throw new StoreConflictError(`Grant ${grantId} does not exist.`);
    if (!Number.isSafeInteger(patch.remaining) || patch.remaining < 0 || patch.remaining > grant.amount) {
      throw new StoreConflictError(`Grant ${grantId} remaining must stay within 0..amount.`);
    }
    this.work.grants.set(grantId, { ...grant, remaining: patch.remaining, revokedAt: patch.revokedAt === undefined ? grant.revokedAt : patch.revokedAt });
  }

  async listHeldReservations(): Promise<Reservation[]> {
    return [...this.work.reservations.values()].filter((row) => row.status === "held");
  }

  async lockReservation(reservationId: string): Promise<Reservation | null> {
    return this.work.reservations.get(reservationId) ?? null;
  }

  async findReservationByKey(idempotencyKey: string): Promise<Reservation | null> {
    return [...this.work.reservations.values()].find((row) => row.idempotencyKey === idempotencyKey) ?? null;
  }

  async insertReservation(input: Omit<Reservation, "id" | "accountId" | "createdAt" | "updatedAt">): Promise<Reservation> {
    this.claim("reservationKeys", input.idempotencyKey, "Reservation");
    const row: Reservation = { ...input, id: this.store.newId("res"), accountId: this.work.account.id, createdAt: this.now, updatedAt: this.now };
    this.work.reservations.set(row.id, row);
    return row;
  }

  async updateReservation(reservationId: string, patch: ReservationPatch): Promise<Reservation> {
    return updateReservationIn(this.work, reservationId, patch, this.now);
  }

  async findEntry(idempotencyKey: string): Promise<LedgerEntry | null> {
    return this.work.entries.find((entry) => entry.idempotencyKey === idempotencyKey) ?? null;
  }

  async insertEntries(entries: readonly NewLedgerEntry[]): Promise<LedgerEntry[]> {
    const rows = entries.map((entry) => {
      if (!Number.isSafeInteger(entry.credits)) throw new StoreConflictError("Ledger credits must be integers.");
      this.claim("entryKeys", entry.idempotencyKey, "Ledger entry");
      return { ...entry, id: this.store.newId("entry"), accountId: this.work.account.id, createdAt: this.now };
    });
    this.work.entries.push(...rows);
    return rows;
  }

  async debtSummary(since: Date): Promise<{ openDebt: number; debtSince: number }> {
    let debt = 0;
    let paid = 0;
    let debtSince = 0;
    for (const entry of this.work.entries) {
      if (entry.kind === "debt") {
        debt += -entry.credits;
        if (entry.createdAt >= since) debtSince += -entry.credits;
      }
      if (entry.kind === "debt_paid") paid += entry.credits;
    }
    return { openDebt: Math.max(0, debt - paid), debtSince };
  }

  async insertUsageReport(input: { identifier: string; credits: number }): Promise<PaygUsageReport> {
    this.claim("reportIds", input.identifier, "Usage report");
    const row: PaygUsageReport = { ...input, accountId: this.work.account.id, createdAt: this.now, reportedAt: null, attempts: 0 };
    this.work.reports.set(row.identifier, row);
    return row;
  }

  async upsertPaygInvoice(invoice: PaygInvoice): Promise<void> {
    if (!this.work.invoices.has(invoice.providerInvoiceId)) this.claim("invoiceIds", invoice.providerInvoiceId, "Invoice");
    this.work.invoices.set(invoice.providerInvoiceId, invoice);
  }

  async getPaygInvoice(providerInvoiceId: string): Promise<PaygInvoice | null> {
    return this.work.invoices.get(providerInvoiceId) ?? null;
  }

  async listPaygInvoices(): Promise<PaygInvoice[]> {
    return [...this.work.invoices.values()];
  }
}

class MemoryReservationTx implements ReservationTx {
  constructor(
    private readonly store: MemoryBillingStore,
    private readonly work: AccountData,
    private readonly staged: StagedKeys,
    private current: Reservation,
    readonly now: Date,
  ) {}

  get reservation(): Reservation {
    return this.current;
  }

  async insertAccrual(input: { callId: string; costPico: PicoUsd | null }): Promise<"inserted" | "duplicate"> {
    if (this.staged.has("callIds", input.callId) || this.store.isKeyTaken("callIds", input.callId)) return "duplicate";
    this.staged.add("callIds", input.callId);
    this.work.accruals.set(input.callId, { reservationId: this.current.id, callId: input.callId, costPico: input.costPico, createdAt: this.now });
    return "inserted";
  }

  async updateReservation(patch: ReservationPatch): Promise<Reservation> {
    this.current = updateReservationIn(this.work, this.current.id, patch, this.now);
    return this.current;
  }

  async listAccruals(): Promise<Accrual[]> {
    return [...this.work.accruals.values()].filter((row) => row.reservationId === this.current.id);
  }
}

function updateReservationIn(work: AccountData, reservationId: string, patch: ReservationPatch, now: Date): Reservation {
  const row = work.reservations.get(reservationId);
  if (!row) throw new StoreConflictError(`Reservation ${reservationId} does not exist.`);
  const next = { ...row, ...patch, updatedAt: now };
  work.reservations.set(reservationId, next);
  return next;
}

function cloneData(data: AccountData): AccountData {
  return structuredClone(data);
}

function counterId(key: UsageCounterKey): string {
  return `${key.accountId}|${key.meterKey}|${key.windowStart.toISOString()}`;
}
