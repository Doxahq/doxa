import { z } from "zod";

import { UNLIMITED, type Catalog, type LimitValue } from "../catalog/define";
import {
  AI_FEATURE_KEYS,
  isFeatureKey,
  isLimitKey,
  isPlanKey,
  type FeatureKey,
  type HostingTier,
  type LimitKey,
  type PlanKey,
} from "../catalog/keys";
import { DAY_MS } from "../clock";
import type { CreditContext } from "../credits/context";
import type { BillingAccount, OverrideRecord, SubscriptionRecord, SubscriptionStatus } from "../store/types";

export type EntitlementSource = "subscription" | "override" | "default";
export type FeatureDenialReason = "not_in_plan" | "coming_soon" | "past_due";

export interface Entitlements {
  readonly plan: PlanKey;
  readonly source: EntitlementSource;
  readonly hosting: HostingTier;
  readonly features: Readonly<Record<FeatureKey, boolean>>;
  /** Why each denied feature is off. */
  readonly featureReasons: Readonly<Partial<Record<FeatureKey, FeatureDenialReason>>>;
  readonly limits: Readonly<Record<LimitKey, LimitValue>>;
  /** False for `self_hosted`: the meter opens no reservation. */
  readonly enforceCredits: boolean;
  readonly subscriptionStatus: SubscriptionStatus | null;
  /** A `past_due` subscription inside the D5 grace period. */
  readonly inGracePeriod: boolean;
  /** Override rows that were active but had a value of the wrong type. They change nothing. */
  readonly ignoredOverrides: readonly string[];
}

export interface ResolveEntitlementsInput {
  readonly catalog: Catalog;
  /** `BILLING_DEFAULT_PLAN`. */
  readonly defaultPlan: PlanKey;
  readonly subscription: SubscriptionRecord | null;
  readonly overrides: readonly OverrideRecord[];
  readonly now: Date;
}

const ENTITLED_STATUSES: readonly SubscriptionStatus[] = ["trialing", "active", "past_due"];

const limitValueSchema = z.union([z.literal(UNLIMITED), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]);
const featureValueSchema = z.boolean();
const planValueSchema = z.string().refine(isPlanKey);

function isActive(override: OverrideRecord, now: Date): boolean {
  return (override.startsAt === null || override.startsAt <= now) && (override.expiresAt === null || now < override.expiresAt);
}

/**
 * spec: when two active overrides name the same key, the one that starts
 * last wins (a null start counts as the earliest); a tie keeps the newest row.
 */
function latestActive(overrides: readonly OverrideRecord[], key: string, now: Date): OverrideRecord[] {
  return overrides
    .filter((row) => row.key === key && isActive(row, now))
    .sort((a, b) => {
      const as = a.startsAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      const bs = b.startsAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      return as !== bs ? bs - as : b.createdAt.getTime() - a.createdAt.getTime();
    });
}

/** The end of the D5 grace period of a past-due subscription. */
export function pastDueGraceEnd(catalog: Catalog, subscription: SubscriptionRecord, now: Date): Date {
  // spec: a past-due row without `pastDueSince` counts from now (in grace) until the next sync sets it.
  const since = subscription.pastDueSince ?? now;
  return new Date(since.getTime() + catalog.subscriptions.pastDueGraceDays * DAY_MS);
}

/**
 * Pure (spec 9.1): plan + status + overrides -> Entitlements.
 * 1. An active `plan` override wins. 2. Else the subscription's price gives
 * the plan, by status. 3. Else the default plan. 4. Single-key overrides
 * then replace plan values. A `planned` action's feature is off on every
 * plan with `coming_soon`.
 */
export function resolveEntitlements(input: ResolveEntitlementsInput): Entitlements {
  const { catalog, subscription, now } = input;
  const ignored: string[] = [];

  let plan: PlanKey = input.defaultPlan;
  let source: EntitlementSource = "default";
  let inGracePeriod = false;
  let pastDueOver = false;

  const planOverride = latestActive(input.overrides, "plan", now).find((row) => {
    const ok = planValueSchema.safeParse(row.value).success;
    if (!ok) ignored.push(row.id);
    return ok;
  });
  if (planOverride && typeof planOverride.value === "string" && isPlanKey(planOverride.value)) {
    plan = planOverride.value;
    source = "override";
  } else if (subscription && ENTITLED_STATUSES.includes(subscription.status)) {
    const pricePlan = catalog.prices[subscription.priceKey]?.plan ?? subscription.planKey;
    if (pricePlan) {
      plan = pricePlan;
      source = "subscription";
      if (subscription.status === "past_due") {
        inGracePeriod = now < pastDueGraceEnd(catalog, subscription, now);
        pastDueOver = !inGracePeriod;
      }
    }
  }

  const definition = catalog.plans[plan];
  const features: Record<FeatureKey, boolean> = { ...definition.features };
  const limits: Record<LimitKey, LimitValue> = { ...definition.limits };
  const reasons: Partial<Record<FeatureKey, FeatureDenialReason>> = {};

  const keys = new Set(input.overrides.filter((row) => row.key !== "plan" && isActive(row, now)).map((row) => row.key));
  for (const key of keys) {
    const [winner] = latestActive(input.overrides, key, now);
    if (!winner) continue;
    if (isFeatureKey(key)) {
      const parsed = featureValueSchema.safeParse(winner.value);
      if (parsed.success) features[key] = parsed.data;
      else ignored.push(winner.id);
    } else if (isLimitKey(key)) {
      const parsed = limitValueSchema.safeParse(winner.value);
      if (parsed.success) limits[key] = parsed.data;
      else ignored.push(winner.id);
    } else {
      ignored.push(winner.id);
    }
  }

  for (const key of Object.keys(features) as FeatureKey[]) {
    if (!features[key]) reasons[key] = "not_in_plan";
  }
  if (pastDueOver) {
    for (const key of AI_FEATURE_KEYS) {
      if (features[key]) {
        features[key] = false;
        reasons[key] = "past_due";
      }
    }
  }
  for (const action of Object.values(catalog.actions)) {
    if (action.status === "planned" && action.feature) {
      features[action.feature] = false;
      reasons[action.feature] = "coming_soon";
    }
  }

  return {
    plan,
    source,
    hosting: definition.hosting,
    features,
    featureReasons: reasons,
    limits,
    enforceCredits: definition.enforceCredits,
    subscriptionStatus: subscription?.status ?? null,
    inGracePeriod,
    ignoredOverrides: ignored,
  };
}

/** The credit context of an account, from its entitlements and subscription mirror. */
export function creditContextFor(input: {
  catalog: Catalog;
  entitlements: Entitlements;
  subscription: SubscriptionRecord | null;
  account: Pick<BillingAccount, "createdAt">;
}): CreditContext {
  const { entitlements, subscription } = input;
  const definition = input.catalog.plans[entitlements.plan];
  const onSubscription = entitlements.source === "subscription" && subscription !== null;
  const trialing = onSubscription && subscription.status === "trialing";
  // spec: an account without a subscription (an Enterprise override) counts its windows from its creation.
  const windowAnchor = onSubscription ? subscription.billingAnchor : input.account.createdAt;
  const monthly = entitlements.limits["ai.credits_monthly"];
  const allowance =
    !trialing && typeof monthly === "number" && monthly > 0 ? { anchor: windowAnchor, monthlyCredits: monthly } : null;
  const trialGrant =
    trialing && definition.trial && subscription
      ? {
          sourceRef: `trial:${subscription.providerSubscriptionId}`,
          credits: definition.trial.credits,
          startsAt: subscription.currentPeriodStart,
          endsAt: subscription.trialEnd ?? subscription.currentPeriodEnd,
        }
      : null;
  return {
    enforceCredits: entitlements.enforceCredits,
    planAllowsPayg: entitlements.features["ai.payg"],
    trialing,
    allowance,
    trialGrant,
    windowAnchor,
  };
}

/** True when the feature is on. */
export function hasFeature(entitlements: Entitlements, key: FeatureKey): boolean {
  return entitlements.features[key];
}

/** True when `used + adding` stays within the limit. */
export function withinLimit(entitlements: Entitlements, key: LimitKey, used: number, adding = 1): boolean {
  const limit = entitlements.limits[key];
  return limit === UNLIMITED || used + adding <= limit;
}
