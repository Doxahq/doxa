import {
  ACTION_KEYS,
  BILLING_INTERVALS,
  FEATURE_KEYS,
  LIMIT_KEYS,
  PLAN_KEYS,
  type ActionKey,
  type BillingInterval,
  type FeatureKey,
  type HostingTier,
  type LimitKey,
  type PlanKey,
} from "./keys";

/**
 * "No limit". A branded string, never `Infinity`, so it survives JSON. The
 * adapters map it to the value that each old contract accepts.
 */
export const UNLIMITED = "unlimited" as const;
export type Unlimited = typeof UNLIMITED;
export type LimitValue = number | Unlimited;

export const MB = 1024 * 1024;

export function isUnlimited(value: LimitValue): value is Unlimited {
  return value === UNLIMITED;
}

export interface TrialDefinition {
  readonly days: number;
  readonly credits: number;
  readonly requiresPaymentMethod: boolean;
}

export interface PlanDefinition {
  readonly name: string;
  readonly selfServe: boolean;
  readonly hosting: HostingTier;
  /**
   * False only for `self_hosted`: AI actions run without credits.
   * spec: section 7.1 says "credits not enforced" in a comment; this flag makes it data.
   */
  readonly enforceCredits: boolean;
  readonly features: Readonly<Record<FeatureKey, boolean>>;
  readonly limits: Readonly<Record<LimitKey, LimitValue>>;
  readonly trial?: TrialDefinition;
}

export interface PriceDefinition {
  readonly plan: PlanKey;
  readonly interval: BillingInterval;
  readonly amountCents: number;
  /** The usage price that goes into the same Checkout. It must have the same interval. */
  readonly usage: string;
  /** False for an old version: customers on it stay, new Checkouts cannot use it. */
  readonly availableForNewCustomers?: boolean;
}

export interface UsagePriceDefinition {
  readonly interval: BillingInterval;
  readonly unitAmountCents: number;
  readonly meter: string;
}

export interface OfferDefinition {
  readonly label: string;
  readonly maxAccounts: number;
  readonly prices: Readonly<Record<BillingInterval, string>>;
  /** The prices for new Checkouts when the offer is full. */
  readonly then: Readonly<Record<BillingInterval, string>>;
}

export interface PaygDefinition {
  readonly defaultOn: boolean;
  readonly duringTrial: boolean;
  readonly chargeAtCredits: number;
  readonly maxDebtCredits: number;
  readonly defaultMonthlyLimitCents: number;
  readonly monthlyLimitRangeCents: readonly [number, number];
  readonly sweepMinCredits: number;
}

export interface UsageDefinition {
  /** One markup for every model. At most 2 decimals. */
  readonly markup: number;
  readonly extendStepCredits: number;
}

export type ChargeRule = "base+usage" | "usage" | "none";
export type ChargeRules = Readonly<Record<string, ChargeRule>>;

export interface MeteredPricing {
  readonly kind: "metered";
  readonly base: number;
  /** The lowest cap that a user can set. A lower cap stops a run before it does real work. */
  readonly minCap: number;
  readonly defaultCap: number;
  readonly maxCap: number;
  /** The margin for a large cap. The meter uses a smaller margin for a small cap (`marginFor`). */
  readonly inFlightMarginCredits: number;
  readonly defaultEstimateCredits: number;
  readonly charge: ChargeRules;
}

/** A fixed price. The meter treats it as metered with markup 0 and base = credits. */
export interface FlatPricing {
  readonly kind: "flat";
  readonly credits: number;
  readonly charge: ChargeRules;
}

export interface FreePricing {
  readonly kind: "free";
}

/** Only a `planned` action can have unset pricing. */
export interface UnsetPricing {
  readonly kind: "unset";
  readonly charge: ChargeRules;
}

export type ActionPricing = MeteredPricing | FlatPricing | FreePricing | UnsetPricing;

export interface ActionDefinition {
  readonly status: "live" | "planned";
  /**
   * The feature that admits the action.
   * spec: not in the 7.1 sketch; entitlements need it to deny a planned action with `coming_soon`.
   */
  readonly feature?: FeatureKey;
  readonly pricing: ActionPricing;
  readonly perSiteDailyCapCredits?: number | null;
}

export interface Catalog {
  readonly version: number;
  readonly currency: "usd";
  readonly credit: { readonly unitPriceCents: number };
  readonly plans: Readonly<Record<PlanKey, PlanDefinition>>;
  readonly prices: Readonly<Record<string, PriceDefinition>>;
  readonly usagePrices: Readonly<Record<string, UsagePriceDefinition>>;
  readonly offers: Readonly<Record<string, OfferDefinition>>;
  readonly payg: PaygDefinition;
  readonly usage: UsageDefinition;
  /**
   * spec: the D5 grace period (7 days) has no place in the 7.1 sketch; it lives here so the
   * catalog stays the one file for billing numbers.
   */
  readonly subscriptions: {
    readonly pastDueGraceDays: number;
    /**
     * Limits that replace the plan values once a past-due subscription is
     * past its grace period. An override still wins over them.
     */
    readonly pastDueLimits?: Readonly<Partial<Record<LimitKey, LimitValue>>>;
  };
  readonly actions: Readonly<Record<ActionKey, ActionDefinition>>;
  readonly safety: { readonly maxDailyModelCostUsdPerAccount: number };
}

export class CatalogError extends Error {
  override readonly name = "CatalogError";
  constructor(readonly problems: readonly string[]) {
    super(`The billing catalog is not valid:\n- ${problems.join("\n- ")}`);
  }
}

/** Checks the catalog at import time. A wrong catalog fails startup and the tests. */
export function defineCatalog<const T extends Catalog>(catalog: T): T {
  const problems = findCatalogProblems(catalog);
  if (problems.length > 0) throw new CatalogError(problems);
  return catalog;
}

const isNonNegativeInt = (value: number) => Number.isSafeInteger(value) && value >= 0;
const isPositiveInt = (value: number) => Number.isSafeInteger(value) && value > 0;

/** Every rule of spec section 20.1 `catalog.test.ts`. Empty means valid. */
export function findCatalogProblems(catalog: Catalog): string[] {
  const problems: string[] = [];
  const problem = (message: string) => problems.push(message);

  if (!isPositiveInt(catalog.credit.unitPriceCents)) problem("credit.unitPriceCents must be a positive integer");

  for (const planKey of PLAN_KEYS) {
    const plan = catalog.plans[planKey];
    if (!plan) {
      problem(`plan ${planKey} is missing`);
      continue;
    }
    for (const key of FEATURE_KEYS) {
      if (typeof plan.features[key] !== "boolean") problem(`plan ${planKey} does not list feature ${key}`);
    }
    for (const key of LIMIT_KEYS) {
      const value = plan.limits[key];
      if (value === undefined) problem(`plan ${planKey} does not list limit ${key}`);
      else if (!isUnlimited(value) && !isNonNegativeInt(value)) problem(`plan ${planKey} limit ${key} must be a non-negative integer or UNLIMITED`);
    }
    for (const key of Object.keys(plan.features)) {
      if (!(FEATURE_KEYS as readonly string[]).includes(key)) problem(`plan ${planKey} has unknown feature ${key}`);
    }
    for (const key of Object.keys(plan.limits)) {
      if (!(LIMIT_KEYS as readonly string[]).includes(key)) problem(`plan ${planKey} has unknown limit ${key}`);
    }
    if (plan.trial) {
      if (!isPositiveInt(plan.trial.days)) problem(`plan ${planKey} trial days must be a positive integer`);
      if (!isNonNegativeInt(plan.trial.credits)) problem(`plan ${planKey} trial credits must be a non-negative integer`);
    }
    if (planKey !== "free" && plan.selfServe && !Object.values(catalog.prices).some((price) => price.plan === planKey)) {
      problem(`self-serve plan ${planKey} has no price`);
    }
  }
  for (const planKey of Object.keys(catalog.plans)) {
    if (!(PLAN_KEYS as readonly string[]).includes(planKey)) problem(`unknown plan ${planKey}`);
  }
  if (catalog.plans.free && catalog.plans.free.limits["ai.credits_monthly"] !== 0) problem("plan free must have 0 monthly credits");

  for (const [key, price] of Object.entries(catalog.prices)) {
    if (!/_v\d+$/.test(key)) problem(`price ${key} must end with a version, such as _v1`);
    if (!isPositiveInt(price.amountCents)) problem(`price ${key} amount must be a positive integer`);
    if (!(BILLING_INTERVALS as readonly string[]).includes(price.interval)) problem(`price ${key} has an unknown interval`);
    const usage = catalog.usagePrices[price.usage];
    if (!usage) problem(`price ${key} names unknown usage price ${price.usage}`);
    else if (usage.interval !== price.interval) problem(`price ${key} and its usage price ${price.usage} must have the same interval`);
    if (!catalog.plans[price.plan]) problem(`price ${key} names unknown plan ${price.plan}`);
  }
  for (const [key, usage] of Object.entries(catalog.usagePrices)) {
    if (!/_v\d+$/.test(key)) problem(`usage price ${key} must end with a version, such as _v1`);
    if (!isPositiveInt(usage.unitAmountCents)) problem(`usage price ${key} unit amount must be a positive integer`);
    if (usage.unitAmountCents !== catalog.credit.unitPriceCents) problem(`usage price ${key} must charge one credit at credit.unitPriceCents`);
  }
  const allKeys = [...Object.keys(catalog.prices), ...Object.keys(catalog.usagePrices), ...Object.keys(catalog.offers)];
  if (new Set(allKeys).size !== allKeys.length) problem("price, usage price and offer keys must be unique together");

  for (const [key, offer] of Object.entries(catalog.offers)) {
    if (!isPositiveInt(offer.maxAccounts)) problem(`offer ${key} maxAccounts must be a positive integer`);
    for (const interval of BILLING_INTERVALS) {
      for (const [side, priceKey] of [["prices", offer.prices[interval]], ["then", offer.then[interval]]] as const) {
        const price = priceKey === undefined ? undefined : catalog.prices[priceKey];
        if (!price) problem(`offer ${key} ${side}.${interval} must name an existing price`);
        else if (price.interval !== interval) problem(`offer ${key} ${side}.${interval} names a price with another interval`);
      }
    }
  }

  const payg = catalog.payg;
  for (const [name, value] of [
    ["chargeAtCredits", payg.chargeAtCredits],
    ["maxDebtCredits", payg.maxDebtCredits],
    ["defaultMonthlyLimitCents", payg.defaultMonthlyLimitCents],
    ["sweepMinCredits", payg.sweepMinCredits],
  ] as const) {
    if (!isPositiveInt(value)) problem(`payg.${name} must be a positive integer`);
  }
  if (payg.chargeAtCredits > payg.maxDebtCredits) problem("payg.chargeAtCredits must be <= payg.maxDebtCredits");
  if (payg.sweepMinCredits < 50) problem("payg.sweepMinCredits must be >= 50 (the Stripe threshold minimum)");
  const [low, high] = payg.monthlyLimitRangeCents;
  if (!isPositiveInt(low) || !isPositiveInt(high) || low > high) problem("payg.monthlyLimitRangeCents must be [low, high] positive integers with low <= high");
  if (payg.defaultMonthlyLimitCents < low || payg.defaultMonthlyLimitCents > high) problem("payg.defaultMonthlyLimitCents must be inside payg.monthlyLimitRangeCents");

  if (!(catalog.usage.markup >= 1)) problem("usage.markup must be at least 1");
  if (!Number.isInteger(Math.round(catalog.usage.markup * 100)) || Math.abs(catalog.usage.markup * 100 - Math.round(catalog.usage.markup * 100)) > 1e-9) {
    problem("usage.markup must have at most 2 decimals");
  }
  if (!isPositiveInt(catalog.usage.extendStepCredits)) problem("usage.extendStepCredits must be a positive integer");
  if (!isNonNegativeInt(catalog.subscriptions.pastDueGraceDays)) problem("subscriptions.pastDueGraceDays must be a non-negative integer");
  for (const [key, value] of Object.entries(catalog.subscriptions.pastDueLimits ?? {})) {
    if (!(LIMIT_KEYS as readonly string[]).includes(key)) problem(`subscriptions.pastDueLimits has an unknown limit ${key}`);
    else if (value === undefined || (!isUnlimited(value) && !isNonNegativeInt(value))) {
      problem(`subscriptions.pastDueLimits.${key} must be a non-negative integer or UNLIMITED`);
    }
  }

  for (const actionKey of ACTION_KEYS) {
    const action = catalog.actions[actionKey];
    if (!action) {
      problem(`action ${actionKey} is missing`);
      continue;
    }
    const pricing = action.pricing;
    if (action.status === "live" && pricing.kind === "unset") problem(`live action ${actionKey} cannot have unset pricing`);
    if (action.status === "live" && action.perSiteDailyCapCredits === null) problem(`live action ${actionKey} needs perSiteDailyCapCredits`);
    if (pricing.kind === "metered") {
      for (const [name, value] of [
        ["base", pricing.base],
        ["minCap", pricing.minCap],
        ["defaultCap", pricing.defaultCap],
        ["maxCap", pricing.maxCap],
        ["inFlightMarginCredits", pricing.inFlightMarginCredits],
        ["defaultEstimateCredits", pricing.defaultEstimateCredits],
      ] as const) {
        if (!isNonNegativeInt(value)) problem(`action ${actionKey} ${name} must be a non-negative integer`);
      }
      if (!(pricing.base <= pricing.minCap && pricing.minCap <= pricing.defaultCap && pricing.defaultCap <= pricing.maxCap)) {
        problem(`action ${actionKey} needs base <= minCap <= defaultCap <= maxCap`);
      }
    }
    if (pricing.kind === "flat" && !isNonNegativeInt(pricing.credits)) problem(`action ${actionKey} flat credits must be a non-negative integer`);
    if (pricing.kind !== "free" && Object.keys(pricing.charge).length === 0) problem(`action ${actionKey} needs charge rules`);
    if (pricing.kind !== "free" && pricing.charge.failed !== "none") problem(`action ${actionKey} must charge nothing for a failed run`);
  }
  for (const actionKey of Object.keys(catalog.actions)) {
    if (!(ACTION_KEYS as readonly string[]).includes(actionKey)) problem(`unknown action ${actionKey}`);
  }
  return problems;
}

/** Every feature on, except the listed ones. */
export function featuresExcept(...off: FeatureKey[]): Readonly<Record<FeatureKey, boolean>> {
  return Object.fromEntries(FEATURE_KEYS.map((key) => [key, !off.includes(key)])) as Record<FeatureKey, boolean>;
}
