import type { Catalog } from "../catalog/define";
import type { ActionKey } from "../catalog/keys";
import type { Clock } from "../clock";
import { BillingNotFoundError, BillingStateError } from "../errors";
import type { BillingStore } from "../store/store";
import type { Reservation, StopReason } from "../store/types";
import type { CreditContext } from "./context";
import { CreditLedger, type SettleResult } from "./ledger";
import {
  chargeCredits,
  chargeRuleFor,
  firstHoldCredits,
  marginFor,
  meterPricingFor,
  resolveCap,
  runningPrice,
  usageCredits,
  type MeterPricing,
} from "./pricing";
import { formatUsd12, parseUsd } from "./usd";

/**
 * The credit meter of a metered action (spec 10.5): open at admission,
 * accrue for each model call, extend the hold in steps, stop at the cap or
 * when credits run out, settle at the end.
 */

export interface MeterSubject {
  /** `job` for generation and Doxabot runs, `chat_request` for docs chat. */
  readonly kind: string;
  readonly id: string;
}

export interface MeterEvents {
  /** Structured counters of spec section 18 (`credits.reserve`, `credits.late_usage`, ...). */
  count?(name: string, fields: Readonly<Record<string, string | number | boolean | null>>): void;
}

export interface CreditMeterDeps {
  readonly store: BillingStore;
  readonly catalog: Catalog;
  readonly clock: Clock;
  /** Builds the account's credit context (entitlements + subscription mirror). */
  readonly creditContext: (accountId: string) => Promise<CreditContext>;
  /** The hash of the model price table, stored on each settle entry (spec 10.8). */
  readonly priceTableHash: string;
  readonly events?: MeterEvents;
  readonly ledger?: CreditLedger;
}

export type OpenResult =
  | { readonly kind: "reserved"; readonly reservation: Reservation; readonly capCredits: number; readonly replayed: boolean }
  /** The action costs nothing (`free` pricing) or the plan does not enforce credits (`self_hosted`). */
  | { readonly kind: "not_metered"; readonly reason: "free_action" | "credits_not_enforced" };

export interface OpenInput {
  readonly accountId: string;
  readonly actionKey: ActionKey;
  readonly subject: MeterSubject;
  /** The usage estimate for the first hold. Default: the action's `defaultEstimateCredits`. */
  readonly estimateCredits?: number;
  /** The cap for this run. Default: the account's cap for the action, else `defaultCap`. */
  readonly capCredits?: number;
  readonly idempotencyKey?: string;
}

export type AccrueResult =
  | { readonly status: "accrued" | "duplicate" | "unpriced"; readonly stop: StopReason | null; readonly priceSoFar: number }
  /** The run was settled or released before this record arrived. Not charged. */
  | { readonly status: "late"; readonly stop: null; readonly priceSoFar: number }
  | { readonly status: "no_reservation"; readonly stop: null; readonly priceSoFar: 0 };

/** The credits of one subject over all its admissions (a continued job has one for each). */
export interface SubjectCredits {
  /** The charge of each settled admission plus the running price of each held one. */
  readonly usedCredits: number;
  /** The newest admission alone: its running price while held, else its charge. */
  readonly latestCredits: number;
  /** The part of the settled charges that pay-as-you-go paid. */
  readonly settledDebtCredits: number;
}

export interface RunStatus {
  readonly active: boolean;
  readonly stopReason: StopReason | null;
}

export class CreditMeter {
  readonly ledger: CreditLedger;

  constructor(private readonly deps: CreditMeterDeps) {
    this.ledger = deps.ledger ?? new CreditLedger({ store: deps.store, catalog: deps.catalog, clock: deps.clock });
  }

  pricingOf(actionKey: ActionKey): MeterPricing | null {
    return meterPricingFor(this.deps.catalog, actionKey);
  }

  /**
   * Step 1: the first hold, `base + min(estimate, cap − base)`. Throws
   * `CreditsExhaustedError` (402). The base fee is charged once for each
   * subject: a continued run opens with a base of 0 when an earlier
   * admission of the subject paid it or still holds it.
   */
  async open(input: OpenInput): Promise<OpenResult> {
    const action = this.deps.catalog.actions[input.actionKey];
    if (action.pricing.kind === "unset") {
      throw new BillingStateError("action_unpriced", `Action ${input.actionKey} has no price yet.`);
    }
    const pricing = meterPricingFor(this.deps.catalog, input.actionKey);
    if (!pricing) return { kind: "not_metered", reason: "free_action" };
    const context = await this.deps.creditContext(input.accountId);
    if (!context.enforceCredits) return { kind: "not_metered", reason: "credits_not_enforced" };
    const account = await this.deps.store.getAccount(input.accountId);
    if (!account) throw new BillingNotFoundError(`Billing account ${input.accountId} does not exist.`);

    const capCredits = resolveCap(pricing, input.capCredits ?? account.actionCaps[input.actionKey]);
    const estimate = Math.max(0, Math.floor(input.estimateCredits ?? pricing.defaultEstimateCredits));
    const earlier = await this.deps.store.listReservationsBySubject(input.subject.kind, input.subject.id);
    const baseCredits = earlier.some(paysBase) ? 0 : pricing.baseCredits;
    const result = await this.ledger.reserve({
      accountId: input.accountId,
      actionKey: input.actionKey,
      subjectKind: input.subject.kind,
      subjectId: input.subject.id,
      amount: firstHoldCredits(baseCredits, estimate, capCredits),
      baseCredits,
      capCredits,
      markupHundredths: pricing.markupHundredths,
      unitPriceCents: pricing.unitPriceCents,
      inFlightMarginCredits: marginFor(pricing, capCredits),
      idempotencyKey: input.idempotencyKey ?? `${input.subject.kind}:${input.subject.id}:reserve`,
      context,
    });
    this.count("credits.reserve", { action: input.actionKey, amount: result.reservation.amount });
    return {
      kind: "reserved",
      reservation: result.reservation,
      capCredits: result.reservation.capCredits,
      replayed: result.replayed,
    };
  }

  /**
   * Step 2–4: adds the cost of one model call. A replayed call ID adds
   * nothing. When the headroom falls below the in-flight margin, the hold
   * grows by `extendStepCredits`, up to the cap. When it cannot keep the
   * margin, the meter writes a stop reason (once).
   *
   * spec: the run stops at the cap when the hold is at the cap and the
   * headroom is below the margin, so calls in flight still fit under the cap.
   */
  async accrue(input: { subject: MeterSubject; callId: string; costUsd: number | string | null }): Promise<AccrueResult> {
    const found = await this.activeReservationOf(input.subject);
    if (!found) return { status: "no_reservation", stop: null, priceSoFar: 0 };
    const now = this.deps.clock.now();
    const cost = parseUsd(input.costUsd);

    const step = await this.deps.store.withReservationLock(found.id, now, async (tx) => {
      const reservation = tx.reservation;
      if (reservation.status !== "held") return { kind: "late" as const, reservation };
      const inserted = await tx.insertAccrual({ callId: input.callId, costPico: cost });
      if (inserted === "duplicate") return { kind: "duplicate" as const, reservation };
      const next = cost === null ? reservation : await tx.updateReservation({ consumedCostPico: reservation.consumedCostPico + cost });
      return { kind: cost === null ? ("unpriced" as const) : ("accrued" as const), reservation: next };
    });

    const price = priceOf(step.reservation);
    if (step.kind === "late") {
      this.count("credits.late_usage", { action: found.actionKey });
      return { status: "late", stop: null, priceSoFar: price };
    }
    if (step.kind === "unpriced") this.count("credits.unpriced_model", { action: found.actionKey, callId: input.callId });
    let reservation = step.reservation;
    if (step.kind !== "duplicate" && reservation.stopReason === null) {
      reservation = await this.keepMargin(reservation, price);
    }
    return { status: step.kind, stop: reservation.stopReason, priceSoFar: price };
  }

  /** `isJobActive`: false with the reason once the meter wrote a stop. A subject without a reservation is active. */
  async status(subject: MeterSubject): Promise<RunStatus> {
    const reservation = await this.activeReservationOf(subject);
    if (!reservation) return { active: true, stopReason: null };
    return { active: reservation.status === "held" && reservation.stopReason === null, stopReason: reservation.stopReason };
  }

  /**
   * The reservation that the subject's running try uses: its held one, else
   * the newest. The ledger allows one held reservation for each subject
   * (`RESERVATION_IN_USE`); a hold left from before that rule still wins
   * over a newer released one.
   */
  async activeReservationOf(subject: MeterSubject): Promise<Reservation | null> {
    return activeOf(await this.deps.store.listReservationsBySubject(subject.kind, subject.id));
  }

  /**
   * Step 5: debits the price from the charge rule of `outcome` and frees the
   * rest, for every held reservation of the subject, oldest first (a resumed
   * job keeps its ID and has one reservation for each admission). Idempotent
   * by each reservation's settle key. With nothing held, it replays the
   * newest reservation's settle (`replayed` or `not_held`).
   */
  async settle(input: { subject: MeterSubject; outcome: string }): Promise<SettleResult & { readonly price: number }> {
    const all = await this.deps.store.listReservationsBySubject(input.subject.kind, input.subject.id);
    const newest = all.at(-1);
    if (!newest) throw new BillingNotFoundError(`No reservation for ${input.subject.kind} ${input.subject.id}.`);
    const held = all.filter((row) => row.status === "held");
    if (held.length === 0) return this.settleReservation({ reservationId: newest.id, subject: input.subject, outcome: input.outcome });
    const results: (SettleResult & { readonly price: number })[] = [];
    for (const row of held) results.push(await this.settleReservation({ reservationId: row.id, subject: input.subject, outcome: input.outcome }));
    return sumSettles(results);
  }

  /**
   * Settles one reservation by its ID (the cron sweep). The price comes from
   * the reservation row read under the ledger's lock, so an accrual that
   * commits before the settle is always charged.
   */
  async settleReservation(input: { reservationId: string; subject?: MeterSubject; outcome: string }): Promise<SettleResult & { readonly price: number }> {
    const reservation = await this.deps.store.getReservation(input.reservationId);
    if (!reservation) throw new BillingNotFoundError(`Reservation ${input.reservationId} does not exist.`);
    const subject = input.subject ?? { kind: reservation.subjectKind, id: reservation.subjectId };
    const pricing = meterPricingFor(this.deps.catalog, reservation.actionKey);
    if (!pricing) throw new BillingStateError("action_unpriced", `Action ${reservation.actionKey} has no meter pricing.`);
    const rule = chargeRuleFor(pricing, input.outcome);
    const priceAt = (locked: Reservation) =>
      chargeCredits({
        rule,
        baseCredits: locked.baseCredits,
        usageCredits: usageCredits(locked.consumedCostPico, locked.markupHundredths, locked.unitPriceCents),
        capCredits: locked.capCredits,
      });
    let price = priceAt(reservation);
    const context = await this.deps.creditContext(reservation.accountId);
    const result = await this.ledger.settle({
      reservationId: reservation.id,
      credits: (locked) => {
        price = priceAt(locked);
        return price;
      },
      idempotencyKey: settleKeyOf(reservation, subject),
      context,
      metadata: (locked) => ({
        modelCostUsd: formatUsd12(locked.consumedCostPico),
        markup: locked.markupHundredths / 100,
        baseCredits: locked.baseCredits,
        capCredits: locked.capCredits,
        priceTableHash: this.deps.priceTableHash,
        outcome: input.outcome,
        chargeRule: rule,
      }),
    });
    if (result.outcome === "settled") {
      this.count("credits.settle", { action: reservation.actionKey, charged: result.charged, outcome: input.outcome });
      if (result.shortfall > 0) this.count("credits.shortfall", { action: reservation.actionKey, credits: result.shortfall });
    }
    return { ...result, price };
  }

  /** Frees every held reservation of the subject without a charge. For a job that is gone. */
  async release(input: { subject: MeterSubject; reason: string }): Promise<{ outcome: "released" | "not_held"; released: number }> {
    const all = await this.deps.store.listReservationsBySubject(input.subject.kind, input.subject.id);
    if (all.length === 0) throw new BillingNotFoundError(`No reservation for ${input.subject.kind} ${input.subject.id}.`);
    let released = 0;
    let any = false;
    for (const row of all.filter((reservation) => reservation.status === "held")) {
      const result = await this.releaseReservation({ reservationId: row.id, reason: input.reason });
      if (result.outcome === "released") {
        any = true;
        released += result.released;
      }
    }
    return { outcome: any ? "released" : "not_held", released };
  }

  /**
   * The credits of a subject over all its admissions, for the live meter of a
   * continued run: it shows the job's total, which only goes up. A released
   * admission counts 0.
   */
  async creditsOf(subject: MeterSubject): Promise<SubjectCredits> {
    const all = await this.deps.store.listReservationsBySubject(subject.kind, subject.id);
    const creditsOfRow = (row: Reservation) =>
      row.status === "held" ? priceOf(row) : row.status === "settled" ? (row.settledAmount ?? 0) : 0;
    const charged = all.filter((row) => row.status === "settled" && (row.settledAmount ?? 0) > 0).map((row) => row.id);
    const latest = activeOf(all);
    return {
      usedCredits: all.reduce((total, row) => total + creditsOfRow(row), 0),
      latestCredits: latest ? creditsOfRow(latest) : 0,
      settledDebtCredits: charged.length > 0 ? await this.deps.store.sumDebtCredits(charged) : 0,
    };
  }

  /** Frees one reservation by its ID without a charge. */
  async releaseReservation(input: { reservationId: string; reason: string }): Promise<{ outcome: "released" | "not_held"; released: number }> {
    const result = await this.ledger.release({ reservationId: input.reservationId, reason: input.reason });
    if (result.outcome === "released") {
      const reservation = await this.deps.store.getReservation(input.reservationId);
      this.count("credits.release", { action: reservation?.actionKey ?? null, credits: result.released });
    }
    return result;
  }

  private async keepMargin(reservation: Reservation, price: number): Promise<Reservation> {
    const margin = reservation.inFlightMarginCredits;
    if (reservation.amount - price >= margin) return reservation;
    const context = await this.deps.creditContext(reservation.accountId);
    // At least one step, and enough to restore the margin: a large call can
    // use more than one step, and a short extension would stop the run as
    // `credits_exhausted` while the account still has credits.
    const shortBy = price + margin - reservation.amount;
    const result = await this.ledger.extend({
      reservationId: reservation.id,
      accountId: reservation.accountId,
      by: Math.max(this.deps.catalog.usage.extendStepCredits, shortBy),
      context,
      stopIfShort: { marginCredits: margin },
    });
    if (result.added > 0) this.count("credits.extend", { action: reservation.actionKey, added: result.added });
    if (result.reservation.stopReason !== null && reservation.stopReason === null) {
      this.count("credits.stop", { action: reservation.actionKey, reason: result.reservation.stopReason });
    }
    return result.reservation;
  }

  private count(name: string, fields: Readonly<Record<string, string | number | boolean | null>>): void {
    this.deps.events?.count?.(name, fields);
  }
}

/**
 * `<kind>:<id>:settle` for the subject's first reservation (spec 10.5 step 5,
 * also the usage report identifier). A later reservation of the same subject
 * (a continued run, opened with its own idempotency key) settles under
 * `<its key>:settle`, so its settle is not a replay of the first one.
 */
function settleKeyOf(reservation: Reservation, subject: MeterSubject): string {
  const first = `${subject.kind}:${subject.id}:reserve`;
  return reservation.idempotencyKey === first ? `${subject.kind}:${subject.id}:settle` : `${reservation.idempotencyKey}:settle`;
}

/** The results of several settles of one subject, added up. */
function sumSettles(results: readonly (SettleResult & { readonly price: number })[]): SettleResult & { readonly price: number } {
  const total = { charged: 0, fromGrants: 0, debt: 0, shortfall: 0, released: 0, price: 0 };
  for (const result of results) {
    total.charged += result.charged;
    total.fromGrants += result.fromGrants;
    total.debt += result.debt;
    total.shortfall += result.shortfall;
    total.released += result.released;
    total.price += result.price;
  }
  const outcome = results.some((result) => result.outcome === "settled")
    ? "settled"
    : results.some((result) => result.outcome === "replayed")
      ? "replayed"
      : "not_held";
  return { outcome, ...total };
}

/**
 * True when an earlier admission of the subject pays the base fee: it charged
 * something at its settle (a run stopped for credits), or it is still held and
 * settles with the same outcome as the newer one. A failed or released
 * admission charged nothing, so the next one pays the base.
 */
function paysBase(reservation: Reservation): boolean {
  if (reservation.status === "held") return reservation.baseCredits > 0;
  return reservation.status === "settled" && (reservation.settledAmount ?? 0) > 0;
}

/** The newest held reservation of a subject's rows (oldest first), else the newest row. */
function activeOf(rows: readonly Reservation[]): Reservation | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.status === "held") return row;
  }
  return rows.at(-1) ?? null;
}

function priceOf(reservation: Reservation): number {
  return runningPrice(
    { baseCredits: reservation.baseCredits, markupHundredths: reservation.markupHundredths, unitPriceCents: reservation.unitPriceCents },
    reservation.consumedCostPico,
    reservation.capCredits,
  );
}
