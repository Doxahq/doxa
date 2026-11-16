import type { Catalog } from "../catalog/define";
import type { ActionKey } from "../catalog/keys";
import type { Clock } from "../clock";
import { DAY_MS, addMs } from "../clock";
import { BillingNotFoundError, BillingStateError, CreditsExhaustedError, RESERVATION_IN_USE } from "../errors";
import type { AccountTx, BillingStore } from "../store/store";
import type {
  CreditGrant,
  GrantKind,
  JsonObject,
  LedgerEntry,
  NewLedgerEntry,
  Reservation,
} from "../store/types";
import { allowanceSourceRef, allowanceWindow } from "./allowance";
import type { CreditContext } from "./context";
import { debtRoom, exhaustedReason, paygStatus, type DebtRoom, type PaygStatus } from "./payg";
import { runningPrice } from "./pricing";

/**
 * The credit ledger (spec 10.1, 10.2). Every write runs in one
 * `withAccountLock` transaction, has an idempotency key, and keeps the
 * invariant: the sum of ledger entries = the sum of grant `remaining` − the
 * open debt.
 *
 * Entry semantics:
 * - `grant` +amount, `expire` / `revoke` −remaining of one grant.
 * - `debit` −credits taken from one grant (one entry per grant), `debt`
 *   −credits above all grants, `debt_paid` +credits of a paid invoice.
 * - `release`, `shortfall` and `adjust` carry 0 credits; their metadata
 *   records the freed hold, the credits Doxa absorbed, or a refund.
 *
 * An operation with key K writes entries `K#0`, `K#1`, ...; `K#0` holds the
 * result in `metadata.result`, so a replay returns the first result.
 */

export interface Balance {
  /** Sum of `remaining` of live grants. */
  readonly granted: number;
  /** Sum of held reservations. */
  readonly held: number;
  readonly openDebt: number;
  readonly debtThisWindow: number;
  readonly debtRoom: number;
  readonly debtLimitedBy: DebtRoom["limitedBy"];
  /** granted + debtRoom − held. Never negative unless a grant expired during a hold. */
  readonly available: number;
  readonly payg: PaygStatus;
  readonly windowStart: Date;
  readonly windowEnd: Date;
}

export interface ReserveInput {
  readonly accountId: string;
  readonly actionKey: ActionKey;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly amount: number;
  readonly baseCredits: number;
  readonly capCredits: number;
  readonly markupHundredths: number;
  readonly unitPriceCents: number;
  readonly inFlightMarginCredits: number;
  readonly idempotencyKey: string;
  readonly context: CreditContext;
  /** Hold lifetime. The cron releases older holds whose job is gone. Default 24 hours. */
  readonly expiresAt?: Date;
}

export interface ReserveResult {
  readonly reservation: Reservation;
  readonly replayed: boolean;
}

export interface SettleInput {
  readonly reservationId: string;
  /**
   * The price of the run, already clamped to the cap. Either a number, or a
   * function of the reservation row read under the lock: the meter passes a
   * function, so an accrual that commits before the lock is charged and one
   * after it finds the reservation settled (`late`).
   */
  readonly credits: number | ((locked: Reservation) => number);
  /** `job:<id>:settle`. Also the identifier of the usage report for any debt. */
  readonly idempotencyKey: string;
  readonly context: CreditContext;
  readonly metadata?: JsonObject | ((locked: Reservation) => JsonObject);
}

export interface SettleResult {
  readonly outcome: "settled" | "replayed" | "not_held";
  readonly charged: number;
  readonly fromGrants: number;
  readonly debt: number;
  readonly shortfall: number;
  readonly released: number;
}

export interface ExtendResult {
  readonly added: number;
  readonly reservation: Reservation;
  readonly balance: Balance;
}

const DEFAULT_HOLD_MS = DAY_MS;

export class CreditLedger {
  constructor(
    private readonly deps: { readonly store: BillingStore; readonly catalog: Catalog; readonly clock: Clock },
  ) {}

  private get store(): BillingStore {
    return this.deps.store;
  }

  /** Ensures the allowance and trial grants, expires due grants, and returns the balance. */
  async balance(accountId: string, context: CreditContext): Promise<Balance> {
    const now = this.deps.clock.now();
    return this.store.withAccountLock(accountId, now, async (tx) => {
      await this.prepare(tx, context, now);
      return this.readBalance(tx, context, now);
    });
  }

  /**
   * Inserts the allowance grant of the window that contains now, with the key
   * `allowance:<accountId>:<windowStart>` (spec 10.3). A new allowance window
   * ends every other open allowance grant (for example after a monthly to
   * yearly switch, which resets the anchor).
   */
  async ensureAllowance(accountId: string, context: CreditContext): Promise<void> {
    const now = this.deps.clock.now();
    await this.store.withAccountLock(accountId, now, (tx) => this.prepare(tx, context, now));
  }

  /** Adds credits. Idempotent by `sourceRef` (unique for each account). */
  async grant(input: {
    accountId: string;
    kind: GrantKind;
    amount: number;
    sourceRef: string;
    startsAt?: Date;
    expiresAt: Date | null;
    metadata?: JsonObject;
  }): Promise<{ grant: CreditGrant; replayed: boolean }> {
    const now = this.deps.clock.now();
    return this.store.withAccountLock(input.accountId, now, async (tx) => {
      const existing = await tx.findGrantBySourceRef(input.sourceRef);
      if (existing) return { grant: existing, replayed: true };
      const grant = await this.insertGrant(tx, { ...input, startsAt: input.startsAt ?? now });
      return { grant, replayed: false };
    });
  }

  /** Holds credits for one action. Throws `CreditsExhaustedError` when the account cannot hold `amount`. */
  async reserve(input: ReserveInput): Promise<ReserveResult> {
    const now = this.deps.clock.now();
    return this.store.withAccountLock(input.accountId, now, async (tx) => {
      const existing = await tx.findReservationByKey(input.idempotencyKey);
      if (existing) return { reservation: existing, replayed: true };
      // One held reservation for each subject. The check runs under the
      // account lock, so two admissions of one job cannot both pass it.
      const held = await tx.listHeldReservations();
      if (held.some((row) => row.subjectKind === input.subjectKind && row.subjectId === input.subjectId)) {
        throw new BillingStateError(RESERVATION_IN_USE, `${input.subjectKind} ${input.subjectId} already holds credits.`);
      }
      await this.prepare(tx, input.context, now);

      const base = {
        actionKey: input.actionKey,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        baseCredits: input.baseCredits,
        markupHundredths: input.markupHundredths,
        unitPriceCents: input.unitPriceCents,
        inFlightMarginCredits: input.inFlightMarginCredits,
        consumedCostPico: 0n,
        stopReason: null,
        status: "held" as const,
        idempotencyKey: input.idempotencyKey,
        expiresAt: input.expiresAt ?? addMs(now, DEFAULT_HOLD_MS),
        settledAmount: null,
      };

      const balance = await this.readBalance(tx, input.context, now);
      if (input.amount > balance.available) {
        throw new CreditsExhaustedError({
          accountId: input.accountId,
          available: Math.max(0, balance.available),
          needed: input.amount,
          reason: exhaustedReason({ trialing: input.context.trialing, payg: balance.payg, room: { room: balance.debtRoom, limitedBy: balance.debtLimitedBy } }),
          resetsAt: balance.windowEnd,
        });
      }
      const reservation = await tx.insertReservation({ ...base, amount: input.amount, capCredits: input.capCredits });
      return { reservation, replayed: false };
    });
  }

  /** Grows a held reservation by up to `by` credits, never above its cap or the available credits. */
  async extend(input: { reservationId: string; accountId: string; by: number; context: CreditContext; stopIfShort?: { marginCredits: number } }): Promise<ExtendResult> {
    const now = this.deps.clock.now();
    return this.store.withAccountLock(input.accountId, now, async (tx) => {
      const reservation = await tx.lockReservation(input.reservationId);
      if (!reservation) throw new BillingNotFoundError(`Reservation ${input.reservationId} does not exist.`);
      await this.prepare(tx, input.context, now);
      const balance = await this.readBalance(tx, input.context, now);
      if (reservation.status !== "held") return { added: 0, reservation, balance };
      const added = Math.max(0, Math.min(input.by, balance.available, reservation.capCredits - reservation.amount));
      let next = reservation;
      if (added > 0) next = await tx.updateReservation(reservation.id, { amount: reservation.amount + added });
      if (input.stopIfShort && next.stopReason === null) {
        const headroom = next.amount - runningPrice(next, next.consumedCostPico, next.capCredits);
        if (headroom < input.stopIfShort.marginCredits) {
          const stopReason = next.amount >= next.capCredits ? "credit_cap" : "credits_exhausted";
          next = await tx.updateReservation(reservation.id, { stopReason });
        }
      }
      return { added, reservation: next, balance: { ...balance, held: balance.held + added, available: balance.available - added } };
    });
  }

  /**
   * Debits the price of a run and frees the rest of its hold (spec 10.5 step 5).
   * Grants that expire first go first, then debt within the debt room. If the
   * account cannot pay it all, the ledger debits what it can and records a
   * `shortfall` that Doxa absorbs. Any debt writes a usage report row with
   * the identifier `idempotencyKey`, in the same transaction.
   */
  async settle(input: SettleInput): Promise<SettleResult> {
    const now = this.deps.clock.now();
    const reservation = await this.store.getReservation(input.reservationId);
    if (!reservation) throw new BillingNotFoundError(`Reservation ${input.reservationId} does not exist.`);
    return this.store.withAccountLock(reservation.accountId, now, async (tx) => {
      const head = await tx.findEntry(`${input.idempotencyKey}#0`);
      if (head) return { ...readResult(head), outcome: "replayed" };
      const locked = await tx.lockReservation(input.reservationId);
      if (!locked || locked.status !== "held") {
        return { outcome: "not_held", charged: 0, fromGrants: 0, debt: 0, shortfall: 0, released: 0 };
      }
      await this.prepare(tx, input.context, now);
      const balance = await this.readBalance(tx, input.context, now);
      const otherHolds = balance.held - locked.amount;
      const payable = Math.max(0, balance.granted + balance.debtRoom - otherHolds);
      const wanted = Math.max(0, Math.floor(typeof input.credits === "function" ? input.credits(locked) : input.credits));
      const metadata = typeof input.metadata === "function" ? input.metadata(locked) : input.metadata;
      const charged = Math.min(wanted, payable);
      const shortfall = wanted - charged;

      const entries: NewLedgerEntry[] = [];
      const common = {
        reservationId: locked.id,
        actionKey: locked.actionKey,
        subjectKind: locked.subjectKind,
        subjectId: locked.subjectId,
      };
      let rest = charged;
      let fromGrants = 0;
      for (const grant of sortForDebit(liveGrants(await tx.listOpenGrants(), now))) {
        if (rest === 0) break;
        const take = Math.min(rest, grant.remaining);
        if (take === 0) continue;
        await tx.updateGrant(grant.id, { remaining: grant.remaining - take });
        entries.push({ ...common, kind: "debit", credits: -take, grantId: grant.id, idempotencyKey: "", metadata: {} });
        rest -= take;
        fromGrants += take;
      }
      const debt = rest;
      if (debt > 0) {
        entries.push({ ...common, kind: "debt", credits: -debt, grantId: null, idempotencyKey: "", metadata: {} });
        await tx.insertUsageReport({ identifier: input.idempotencyKey, credits: debt });
      }
      if (shortfall > 0) {
        entries.push({ ...common, kind: "shortfall", credits: 0, grantId: null, idempotencyKey: "", metadata: { missingCredits: shortfall } });
      }
      const released = Math.max(0, locked.amount - charged);
      entries.push({ ...common, kind: "release", credits: 0, grantId: null, idempotencyKey: "", metadata: { releasedCredits: released } });
      if (entries[0]?.kind !== "debit") {
        // `#0` is always a debit, a 0-credit one when nothing came from a grant.
        entries.unshift({ ...common, kind: "debit", credits: 0, grantId: null, idempotencyKey: "", metadata: {} });
      }
      const result = { outcome: "settled" as const, charged, fromGrants, debt, shortfall, released };
      const keyed = entries.map((entry, index) => ({
        ...entry,
        idempotencyKey: `${input.idempotencyKey}#${index}`,
        metadata: index === 0 ? { ...metadata, ...entry.metadata, result: { ...result } } : entry.metadata,
      }));
      await tx.insertEntries(keyed);
      await tx.updateReservation(locked.id, { status: "settled", settledAmount: charged });
      return result;
    });
  }

  /** Frees a hold without a charge (a job that is gone, a run that never started). Idempotent. */
  async release(input: { reservationId: string; reason: string }): Promise<{ outcome: "released" | "not_held"; released: number }> {
    const now = this.deps.clock.now();
    const reservation = await this.store.getReservation(input.reservationId);
    if (!reservation) throw new BillingNotFoundError(`Reservation ${input.reservationId} does not exist.`);
    return this.store.withAccountLock(reservation.accountId, now, async (tx) => {
      const locked = await tx.lockReservation(input.reservationId);
      if (!locked || locked.status !== "held") return { outcome: "not_held", released: 0 };
      await tx.insertEntries([
        {
          kind: "release",
          credits: 0,
          grantId: null,
          reservationId: locked.id,
          actionKey: locked.actionKey,
          subjectKind: locked.subjectKind,
          subjectId: locked.subjectId,
          idempotencyKey: `${locked.idempotencyKey}:release#0`,
          metadata: { releasedCredits: locked.amount, reason: input.reason },
        },
      ]);
      await tx.updateReservation(locked.id, { status: "released", settledAmount: 0 });
      return { outcome: "released", released: locked.amount };
    });
  }

  /** Takes back what is left of a grant (support, fraud). Idempotent. */
  async revoke(input: { accountId: string; grantId: string; reason: string }): Promise<{ revoked: number }> {
    const now = this.deps.clock.now();
    return this.store.withAccountLock(input.accountId, now, async (tx) => {
      const grant = await tx.getGrant(input.grantId);
      if (!grant) throw new BillingNotFoundError(`Grant ${input.grantId} does not exist.`);
      if (grant.revokedAt !== null) return { revoked: 0 };
      await tx.updateGrant(grant.id, { remaining: 0, revokedAt: now });
      await tx.insertEntries([
        grantEntry("revoke", -grant.remaining, grant.id, `revoke:${grant.id}#0`, { reason: input.reason }),
      ]);
      return { revoked: grant.remaining };
    });
  }

  /** Writes `expire` entries for grants past their expiry (the hourly sweep; every write does it too). */
  async expireGrants(accountId: string): Promise<{ expired: number }> {
    const now = this.deps.clock.now();
    return this.store.withAccountLock(accountId, now, async (tx) => ({ expired: await this.expireDue(tx, now) }));
  }

  /** `invoice.paid` for a usage invoice: clears only that invoice's credits. Idempotent by invoice. */
  async recordDebtPaid(input: { accountId: string; invoiceId: string; credits: number }): Promise<{ cleared: number; replayed: boolean }> {
    const now = this.deps.clock.now();
    return this.store.withAccountLock(input.accountId, now, async (tx) => {
      const key = `debt_paid:${input.invoiceId}#0`;
      const existing = await tx.findEntry(key);
      if (existing) return { cleared: existing.credits, replayed: true };
      const { openDebt } = await tx.debtSummary(now);
      const cleared = Math.max(0, Math.min(Math.floor(input.credits), openDebt));
      await tx.insertEntries([grantEntry("debt_paid", cleared, null, key, { invoiceId: input.invoiceId, invoiceCredits: input.credits })]);
      return { cleared, replayed: false };
    });
  }

  /**
   * Adds debt outside a run: the 1-credit report of the monthly sweep (spec
   * 10.10 step 6). Writes a usage report with `identifier` in the same transaction.
   */
  async addDebt(input: { accountId: string; credits: number; identifier: string; metadata?: JsonObject }): Promise<{ replayed: boolean }> {
    const now = this.deps.clock.now();
    return this.store.withAccountLock(input.accountId, now, async (tx) => {
      if (await tx.findEntry(`${input.identifier}#0`)) return { replayed: true };
      await tx.insertEntries([grantEntry("debt", -input.credits, null, `${input.identifier}#0`, input.metadata ?? {})]);
      await tx.insertUsageReport({ identifier: input.identifier, credits: input.credits });
      return { replayed: false };
    });
  }

  /** A 0-credit audit entry, for example a refunded usage invoice (spec 10.4: the debt does not come back). */
  async recordAdjustment(input: { accountId: string; idempotencyKey: string; metadata: JsonObject }): Promise<{ replayed: boolean }> {
    const now = this.deps.clock.now();
    return this.store.withAccountLock(input.accountId, now, async (tx) => {
      if (await tx.findEntry(`${input.idempotencyKey}#0`)) return { replayed: true };
      await tx.insertEntries([grantEntry("adjust", 0, null, `${input.idempotencyKey}#0`, input.metadata)]);
      return { replayed: false };
    });
  }

  // Internals -----------------------------------------------------------------

  private async prepare(tx: AccountTx, context: CreditContext, now: Date): Promise<void> {
    await this.expireDue(tx, now);
    if (context.allowance && context.allowance.monthlyCredits > 0) {
      const window = allowanceWindow(context.allowance.anchor, now);
      const sourceRef = allowanceSourceRef(tx.account.id, window.start);
      if (!(await tx.findGrantBySourceRef(sourceRef))) {
        // A new window ends the last allowance. The first paid window also ends
        // the trial credits: a trial that ends early (Start Pro now, decision
        // D22) keeps a trial grant that would otherwise expire days later.
        for (const grant of await tx.listOpenGrants()) {
          if (grant.kind === "allowance") await this.expireGrant(tx, grant, "superseded");
          if (grant.kind === "trial") await this.expireGrant(tx, grant, "trial_ended");
        }
        await this.insertGrant(tx, {
          kind: "allowance",
          amount: context.allowance.monthlyCredits,
          sourceRef,
          startsAt: window.start,
          expiresAt: window.end,
        });
      }
    }
    if (context.trialGrant && context.trialGrant.credits > 0 && now < context.trialGrant.endsAt) {
      if (!(await tx.findGrantBySourceRef(context.trialGrant.sourceRef))) {
        await this.insertGrant(tx, {
          kind: "trial",
          amount: context.trialGrant.credits,
          sourceRef: context.trialGrant.sourceRef,
          startsAt: context.trialGrant.startsAt,
          expiresAt: context.trialGrant.endsAt,
        });
      }
    }
  }

  private async insertGrant(
    tx: AccountTx,
    input: { kind: GrantKind; amount: number; sourceRef: string; startsAt: Date; expiresAt: Date | null; metadata?: JsonObject },
  ): Promise<CreditGrant> {
    const grant = await tx.insertGrant({
      kind: input.kind,
      amount: input.amount,
      startsAt: input.startsAt,
      expiresAt: input.expiresAt,
      sourceRef: input.sourceRef,
    });
    await tx.insertEntries([
      grantEntry("grant", grant.amount, grant.id, `grant:${tx.account.id}:${grant.sourceRef}#0`, { kind: grant.kind, ...input.metadata }),
    ]);
    return grant;
  }

  private async expireDue(tx: AccountTx, now: Date): Promise<number> {
    let expired = 0;
    for (const grant of await tx.listOpenGrants()) {
      if (grant.expiresAt !== null && grant.expiresAt <= now) expired += await this.expireGrant(tx, grant, "expired");
    }
    return expired;
  }

  private async expireGrant(tx: AccountTx, grant: CreditGrant, reason: string): Promise<number> {
    if (grant.remaining === 0) return 0;
    await tx.updateGrant(grant.id, { remaining: 0 });
    await tx.insertEntries([grantEntry("expire", -grant.remaining, grant.id, `expire:${grant.id}#0`, { reason })]);
    return grant.remaining;
  }

  private async readBalance(tx: AccountTx, context: CreditContext, now: Date): Promise<Balance> {
    const window = allowanceWindow(context.windowAnchor, now);
    const granted = liveGrants(await tx.listOpenGrants(), now).reduce((sum, grant) => sum + grant.remaining, 0);
    const held = (await tx.listHeldReservations()).reduce((sum, row) => sum + row.amount, 0);
    const { openDebt, debtSince } = await tx.debtSummary(window.start);
    const payg = paygStatus(this.deps.catalog, {
      planAllowsPayg: context.planAllowsPayg,
      trialing: context.trialing,
      settingEnabled: tx.account.paygEnabled,
      aiPausedReason: tx.account.aiPausedReason,
    });
    const room = debtRoom(this.deps.catalog, {
      active: payg.active,
      openDebt,
      debtThisWindow: debtSince,
      monthlyLimitCents: tx.account.paygMonthlyLimitCents,
    });
    return {
      granted,
      held,
      openDebt,
      debtThisWindow: debtSince,
      debtRoom: room.room,
      debtLimitedBy: room.limitedBy,
      available: granted + room.room - held,
      payg,
      windowStart: window.start,
      windowEnd: window.end,
    };
  }
}

function grantEntry(kind: LedgerEntry["kind"], credits: number, grantId: string | null, idempotencyKey: string, metadata: JsonObject): NewLedgerEntry {
  return { kind, credits, grantId, reservationId: null, actionKey: null, subjectKind: null, subjectId: null, idempotencyKey, metadata };
}

function liveGrants(grants: readonly CreditGrant[], now: Date): CreditGrant[] {
  return grants.filter((grant) => grant.revokedAt === null && grant.remaining > 0 && grant.startsAt <= now && (grant.expiresAt === null || grant.expiresAt > now));
}

/** Grants that expire first go first (spec 10.2 rule 5). No expiry goes last. */
export function sortForDebit(grants: readonly CreditGrant[]): CreditGrant[] {
  return [...grants].sort((a, b) => {
    const ae = a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const be = b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (ae !== be) return ae - be;
    if (a.startsAt.getTime() !== b.startsAt.getTime()) return a.startsAt.getTime() - b.startsAt.getTime();
    return a.id.localeCompare(b.id);
  });
}

function readResult(head: LedgerEntry): Omit<SettleResult, "outcome"> {
  const result = head.metadata.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new BillingStateError("corrupt_settle_entry", `Entry ${head.idempotencyKey} has no settle result.`);
  }
  const record = result as Record<string, unknown>;
  const read = (name: string) => (typeof record[name] === "number" ? (record[name] as number) : 0);
  return { charged: read("charged"), fromGrants: read("fromGrants"), debt: read("debt"), shortfall: read("shortfall"), released: read("released") };
}
