import type { Catalog, ChargeRule, ChargeRules } from "../catalog/define";
import type { ActionKey } from "../catalog/keys";
import { BillingInputError } from "../errors";
import { PICO_PER_USD, ceilDiv, type PicoUsd } from "./usd";

/**
 * The price of one metered run (spec 10.5):
 *
 *   credits = base fee + ceil(model cost in USD × markup × 100)
 *
 * with 1 credit = `credit.unitPriceCents` cents. A flat action is a metered
 * action with markup 0 and a base fee equal to its price.
 */
export interface MeterPricing {
  readonly actionKey: ActionKey;
  readonly kind: "metered" | "flat";
  readonly baseCredits: number;
  /** The lowest cap that a user can set. */
  readonly minCap: number;
  /** The markup × 100, as an integer, so the price stays exact. */
  readonly markupHundredths: number;
  readonly unitPriceCents: number;
  readonly defaultCap: number;
  readonly maxCap: number;
  readonly inFlightMarginCredits: number;
  readonly defaultEstimateCredits: number;
  readonly extendStepCredits: number;
  readonly charge: ChargeRules;
}

export function markupHundredths(markup: number): number {
  return Math.round(markup * 100);
}

/** The meter settings of an action, or null for a free action or one without a price. */
export function meterPricingFor(catalog: Catalog, actionKey: ActionKey): MeterPricing | null {
  const action = catalog.actions[actionKey];
  const pricing = action.pricing;
  const common = {
    actionKey,
    unitPriceCents: catalog.credit.unitPriceCents,
    extendStepCredits: catalog.usage.extendStepCredits,
  };
  if (pricing.kind === "metered") {
    return {
      ...common,
      kind: "metered",
      baseCredits: pricing.base,
      markupHundredths: markupHundredths(catalog.usage.markup),
      minCap: pricing.minCap,
      defaultCap: pricing.defaultCap,
      maxCap: pricing.maxCap,
      inFlightMarginCredits: pricing.inFlightMarginCredits,
      defaultEstimateCredits: pricing.defaultEstimateCredits,
      charge: pricing.charge,
    };
  }
  if (pricing.kind === "flat") {
    return {
      ...common,
      kind: "flat",
      baseCredits: pricing.credits,
      markupHundredths: 0,
      minCap: pricing.credits,
      defaultCap: pricing.credits,
      maxCap: pricing.credits,
      inFlightMarginCredits: 0,
      defaultEstimateCredits: 0,
      charge: pricing.charge,
    };
  }
  return null;
}

/** ceil(cost × markup × 100 / unit price): the usage part in whole credits. Rounds once. */
export function usageCredits(cost: PicoUsd, markupHundredthsValue: number, unitPriceCents: number): number {
  if (cost <= 0n || markupHundredthsValue <= 0) return 0;
  // cost [pico USD] × markup × 100 [cents/USD] / unit [cents/credit]
  //   = cost × markupHundredths / (1e12 × unit)
  const credits = ceilDiv(cost * BigInt(markupHundredthsValue), PICO_PER_USD * BigInt(unitPriceCents));
  return Number(credits);
}

/**
 * The cap of a run: the account's cap for the action if set, clamped to
 * [minCap, maxCap], else `defaultCap`. A cap saved before `minCap` existed
 * can be lower: the run uses `minCap`.
 */
export function resolveCap(pricing: MeterPricing, requested?: number | null): number {
  if (requested === undefined || requested === null) return pricing.defaultCap;
  return Math.min(pricing.maxCap, Math.max(pricing.minCap, Math.floor(requested)));
}

/** For `PUT /billing/accounts/:id/caps`: each value from `minCap` up to `maxCap`, else an input error. */
export function validateCap(pricing: MeterPricing, capCredits: number): number {
  if (!Number.isSafeInteger(capCredits) || capCredits < pricing.minCap || capCredits > pricing.maxCap) {
    throw new BillingInputError(
      "cap_out_of_range",
      `The cap of ${pricing.actionKey} must be a whole number from ${pricing.minCap} to ${pricing.maxCap}.`,
    );
  }
  return capCredits;
}

/** The largest part of the cap that the in-flight margin can take. */
export const MARGIN_SHARE_OF_CAP = 0.25;

/**
 * The in-flight margin of a run: the action's margin, but at most a quarter
 * of the cap. With the full margin, a cap near the margin stops the run on
 * its first model call. Calls in flight after a stop can then cost more than
 * the cap: the price stays at the cap and the ledger records a shortfall.
 */
export function marginFor(pricing: MeterPricing, capCredits: number): number {
  return Math.min(pricing.inFlightMarginCredits, Math.floor(capCredits * MARGIN_SHARE_OF_CAP));
}

export function chargeRuleFor(pricing: MeterPricing, outcome: string): ChargeRule {
  const rule = pricing.charge[outcome];
  if (!rule) {
    throw new BillingInputError(
      "unknown_outcome",
      `Action ${pricing.actionKey} has no charge rule for outcome "${outcome}". Known: ${Object.keys(pricing.charge).join(", ")}.`,
    );
  }
  return rule;
}

/** The credits for a rule, never above the cap. */
export function chargeCredits(input: { rule: ChargeRule; baseCredits: number; usageCredits: number; capCredits: number }): number {
  const raw =
    input.rule === "base+usage" ? input.baseCredits + input.usageCredits : input.rule === "usage" ? input.usageCredits : 0;
  return Math.max(0, Math.min(input.capCredits, raw));
}

/** The running price of a run so far, as the meter compares it with its hold. */
export function runningPrice(pricing: Pick<MeterPricing, "baseCredits" | "markupHundredths" | "unitPriceCents">, cost: PicoUsd, cap: number): number {
  return Math.min(cap, pricing.baseCredits + usageCredits(cost, pricing.markupHundredths, pricing.unitPriceCents));
}

/** The first hold at admission: base + min(estimate, cap − base) (spec 10.5 step 1). */
export function firstHoldCredits(baseCredits: number, estimateCredits: number, capCredits: number): number {
  return baseCredits + Math.max(0, Math.min(estimateCredits, capCredits - baseCredits));
}
