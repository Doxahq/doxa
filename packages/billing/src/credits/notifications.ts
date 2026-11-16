import type { Catalog } from "../catalog/define";
import type { Clock } from "../clock";
import type { BillingStore } from "../store/store";
import { allowanceSourceRef, allowanceWindow } from "./allowance";
import type { CreditContext } from "./context";
import type { CreditLedger } from "./ledger";
import { monthlyLimitCredits } from "./payg";

/**
 * Billing notifications (spec 10.7). The package decides which notices an
 * account state calls for; a `BillingNotifier` (the API's email outbox)
 * sends them. Each notice is sent at most once a window: the notifier keys
 * each delivery with `billingNotificationWindowKey`.
 */

/** 80% of the monthly allowance. */
export const CREDITS_LOW_PERCENT = 80;

/** The steps of the monthly pay-as-you-go limit that send a notice. */
export const PAYG_LIMIT_NOTICE_PERCENTS = [50, 80, 100] as const;

export type PaygLimitNoticePercent = (typeof PAYG_LIMIT_NOTICE_PERCENTS)[number];

interface WindowFields {
  readonly accountId: string;
  /** The allowance window (the pay-as-you-go month). */
  readonly windowStart: Date;
  readonly windowEnd: Date;
}

export type BillingNotification =
  | (WindowFields & {
      readonly kind: "credits-low";
      readonly usedCredits: number;
      readonly allowanceCredits: number;
      /** Runs continue on pay-as-you-go after the allowance. */
      readonly paygOn: boolean;
    })
  | (WindowFields & {
      readonly kind: "payg-started";
      readonly monthlyLimitCents: number;
      readonly chargeAtCredits: number;
    })
  | (WindowFields & {
      readonly kind: "payg-limit";
      readonly percent: PaygLimitNoticePercent;
      readonly debtCredits: number;
      readonly monthlyLimitCents: number;
      readonly chargeAtCredits: number;
    })
  | {
      readonly kind: "credits-exhausted";
      readonly accountId: string;
      /** The trial grant's `sourceRef`: one notice for each trial. */
      readonly windowRef: string;
      readonly trialCredits: number | null;
    };

export type BillingNotificationKind = BillingNotification["kind"];

/** The port that sends billing notifications. It never throws. */
export interface BillingNotifier {
  notify(notification: BillingNotification): Promise<void>;
}

export const NO_BILLING_NOTIFIER: BillingNotifier = { notify: async () => undefined };

/**
 * The key of one notice in its window: account + kind + window (+ the limit
 * and the step for `payg-limit`, so a raised limit can warn again).
 */
export function billingNotificationWindowKey(notification: BillingNotification): string {
  switch (notification.kind) {
    case "credits-low":
    case "payg-started":
      return `${notification.kind}:${notification.accountId}:${notification.windowStart.toISOString()}`;
    case "payg-limit":
      return `payg-limit:${notification.accountId}:${notification.windowStart.toISOString()}:${notification.monthlyLimitCents}:${notification.percent}`;
    case "credits-exhausted":
      return `credits-exhausted:${notification.accountId}:${notification.windowRef}`;
  }
}

/** What the notices read about an account, after a settle (or projected, in shadow mode). */
export interface CreditSnapshot {
  readonly accountId: string;
  readonly trialing: boolean;
  readonly paygActive: boolean;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  /** The allowance grant of this window, or null. */
  readonly allowance: { readonly amount: number; readonly remaining: number } | null;
  /** The trial grant, or null. */
  readonly trial: { readonly sourceRef: string; readonly amount: number; readonly remaining: number } | null;
  /** Credits left in every live grant. */
  readonly grantedCredits: number;
  readonly debtThisWindow: number;
  readonly monthlyLimitCents: number;
  readonly monthlyLimitCredits: number;
  readonly chargeAtCredits: number;
}

/** The notices that a snapshot calls for, at most one of each kind. */
export function creditNotifications(snapshot: CreditSnapshot): BillingNotification[] {
  const { accountId, windowStart, windowEnd } = snapshot;
  const window = { accountId, windowStart, windowEnd };
  if (snapshot.trialing) {
    if (snapshot.grantedCredits > 0) return [];
    return [
      {
        kind: "credits-exhausted",
        accountId,
        windowRef: snapshot.trial?.sourceRef ?? `window:${windowStart.toISOString()}`,
        trialCredits: snapshot.trial?.amount ?? null,
      },
    ];
  }

  const notices: BillingNotification[] = [];
  const allowance = snapshot.allowance;
  if (allowance && allowance.amount > 0 && snapshot.debtThisWindow === 0) {
    const used = allowance.amount - allowance.remaining;
    if (used * 100 >= CREDITS_LOW_PERCENT * allowance.amount) {
      notices.push({ ...window, kind: "credits-low", usedCredits: used, allowanceCredits: allowance.amount, paygOn: snapshot.paygActive });
    }
  }
  if (snapshot.debtThisWindow > 0) {
    notices.push({ ...window, kind: "payg-started", monthlyLimitCents: snapshot.monthlyLimitCents, chargeAtCredits: snapshot.chargeAtCredits });
    const limit = snapshot.monthlyLimitCredits;
    const percent = limit > 0 ? [...PAYG_LIMIT_NOTICE_PERCENTS].reverse().find((step) => snapshot.debtThisWindow * 100 >= step * limit) : undefined;
    if (percent !== undefined) {
      notices.push({
        ...window,
        kind: "payg-limit",
        percent,
        debtCredits: snapshot.debtThisWindow,
        monthlyLimitCents: snapshot.monthlyLimitCents,
        chargeAtCredits: snapshot.chargeAtCredits,
      });
    }
  }
  return notices;
}

/**
 * Shadow mode debits nothing: this is the snapshot as if `credits` were
 * debited now. The allowance goes first, then the other grants, then debt
 * (only with active pay-as-you-go; else Doxa absorbs the rest).
 */
export function withProjectedDebit(snapshot: CreditSnapshot, credits: number): CreditSnapshot {
  let rest = Math.max(0, Math.floor(credits));
  const fromGrants = Math.min(rest, Math.max(0, snapshot.grantedCredits));
  rest -= fromGrants;
  const allowanceTake = snapshot.allowance ? Math.min(fromGrants, snapshot.allowance.remaining) : 0;
  const trialTake = snapshot.trial ? Math.min(fromGrants - allowanceTake, snapshot.trial.remaining) : 0;
  return {
    ...snapshot,
    grantedCredits: snapshot.grantedCredits - fromGrants,
    allowance: snapshot.allowance ? { ...snapshot.allowance, remaining: snapshot.allowance.remaining - allowanceTake } : null,
    trial: snapshot.trial ? { ...snapshot.trial, remaining: snapshot.trial.remaining - trialTake } : null,
    debtThisWindow: snapshot.debtThisWindow + (snapshot.paygActive ? rest : 0),
  };
}

export interface CreditSnapshotDeps {
  readonly store: Pick<BillingStore, "getAccount" | "listGrants">;
  readonly ledger: Pick<CreditLedger, "balance">;
  readonly catalog: Catalog;
  readonly clock: Clock;
}

/** Reads the snapshot of an account: its balance, its grants and its pay-as-you-go limit. */
export async function readCreditSnapshot(deps: CreditSnapshotDeps, accountId: string, context: CreditContext): Promise<CreditSnapshot | null> {
  const balance = await deps.ledger.balance(accountId, context);
  const [account, grants] = await Promise.all([deps.store.getAccount(accountId), deps.store.listGrants(accountId)]);
  if (!account) return null;
  const allowanceRef = context.allowance
    ? allowanceSourceRef(accountId, allowanceWindow(context.allowance.anchor, deps.clock.now()).start)
    : null;
  const allowance = allowanceRef ? grants.find((grant) => grant.sourceRef === allowanceRef) ?? null : null;
  const trial = context.trialGrant ? grants.find((grant) => grant.sourceRef === context.trialGrant?.sourceRef) ?? null : null;
  return {
    accountId,
    trialing: context.trialing,
    paygActive: balance.payg.active,
    windowStart: balance.windowStart,
    windowEnd: balance.windowEnd,
    allowance: allowance ? { amount: allowance.amount, remaining: allowance.revokedAt ? 0 : allowance.remaining } : null,
    trial: trial ? { sourceRef: trial.sourceRef, amount: trial.amount, remaining: trial.revokedAt ? 0 : trial.remaining } : null,
    grantedCredits: balance.granted,
    debtThisWindow: balance.debtThisWindow,
    monthlyLimitCents: account.paygMonthlyLimitCents,
    monthlyLimitCredits: monthlyLimitCredits(deps.catalog, account.paygMonthlyLimitCents),
    chargeAtCredits: deps.catalog.payg.chargeAtCredits,
  };
}
