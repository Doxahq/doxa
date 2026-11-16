import type { Catalog } from "../catalog/define";
import { BillingInputError, type CreditsExhaustedReason } from "../errors";
import type { AiPausedReason } from "../store/types";

/**
 * Pure pay-as-you-go rules (spec 10.10, decisions D16–D19). No route starts a
 * charge: the provider charges the debt at the threshold and in the monthly
 * sweep.
 */

export type PaygOffReason = "not_in_plan" | "trial" | "setting_off" | "payment_failed" | "dispute";

export interface PaygInputs {
  /** The `ai.payg` feature of the account's entitlements. */
  readonly planAllowsPayg: boolean;
  readonly trialing: boolean;
  /** `billing_accounts.payg_enabled`. */
  readonly settingEnabled: boolean;
  readonly aiPausedReason: AiPausedReason | null;
}

export interface PaygStatus {
  readonly active: boolean;
  readonly offReason: PaygOffReason | null;
}

export function paygStatus(catalog: Catalog, inputs: PaygInputs): PaygStatus {
  const off = (offReason: PaygOffReason): PaygStatus => ({ active: false, offReason });
  if (!inputs.planAllowsPayg) return off("not_in_plan");
  if (inputs.trialing && !catalog.payg.duringTrial) return off("trial");
  if (inputs.aiPausedReason === "payment_failed") return off("payment_failed");
  if (inputs.aiPausedReason === "dispute") return off("dispute");
  if (!inputs.settingEnabled) return off("setting_off");
  return { active: true, offReason: null };
}

/** The monthly limit in credits. */
export function monthlyLimitCredits(catalog: Catalog, monthlyLimitCents: number): number {
  return Math.floor(monthlyLimitCents / catalog.credit.unitPriceCents);
}

export interface DebtRoom {
  /** Credits that the account may still owe. 0 without active pay-as-you-go. */
  readonly room: number;
  readonly limitedBy: "max_debt" | "monthly_limit" | null;
}

/**
 * The debt room (spec 10.1): `maxDebtCredits` − the open debt, and never
 * more than what is left of the monthly limit in this window.
 */
export function debtRoom(
  catalog: Catalog,
  input: { active: boolean; openDebt: number; debtThisWindow: number; monthlyLimitCents: number },
): DebtRoom {
  if (!input.active) return { room: 0, limitedBy: null };
  const byDebt = catalog.payg.maxDebtCredits - input.openDebt;
  const byMonth = monthlyLimitCredits(catalog, input.monthlyLimitCents) - input.debtThisWindow;
  const room = Math.max(0, Math.min(byDebt, byMonth));
  const limitedBy = byMonth < byDebt ? "monthly_limit" : "max_debt";
  return { room, limitedBy };
}

/** `PUT /billing/accounts/:id/payg`: `monthlyLimitCents` from 500 to 20,000, else a 400. */
export function validateMonthlyLimitCents(catalog: Catalog, cents: number): number {
  const [low, high] = catalog.payg.monthlyLimitRangeCents;
  if (!Number.isSafeInteger(cents) || cents < low || cents > high) {
    throw new BillingInputError("monthly_limit_out_of_range", `The monthly limit must be a whole number of cents from ${low} to ${high}.`);
  }
  return cents;
}

/** The provider billing threshold, in cents. */
export function chargeThresholdCents(catalog: Catalog): number {
  return catalog.payg.chargeAtCredits * catalog.credit.unitPriceCents;
}

/** The monthly sweep amount: the unbilled debt when it is at least `sweepMinCredits`, else 0 (no sweep). */
export function sweepCredits(catalog: Catalog, unbilledDebtCredits: number): number {
  return unbilledDebtCredits >= catalog.payg.sweepMinCredits ? unbilledDebtCredits : 0;
}

export function defaultPaygSettings(catalog: Catalog, paidPlan: boolean): { enabled: boolean; monthlyLimitCents: number } {
  return { enabled: paidPlan && catalog.payg.defaultOn, monthlyLimitCents: catalog.payg.defaultMonthlyLimitCents };
}

/** The `reason` of a `credits_exhausted` answer (spec 10.6). */
export function exhaustedReason(input: { trialing: boolean; payg: PaygStatus; room: DebtRoom }): CreditsExhaustedReason {
  if (input.trialing) return "trial_credits";
  if (!input.payg.active) return input.payg.offReason === "payment_failed" ? "past_due" : "payg_off";
  return input.room.limitedBy === "monthly_limit" ? "monthly_limit" : "max_debt";
}
