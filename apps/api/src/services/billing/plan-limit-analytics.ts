import { CreditsExhaustedError, PlanLimitError } from "@doxahq/billing";
import type { AnalyticsGroups, AnyProductEvent } from "@doxahq/analytics";
import type { Env } from "../../env";
import { productAnalyticsOf } from "../analytics/product-analytics";
import { billingConfigFor } from "./config";
import { billingCoreFromEnv } from "./core";

/** A refusal that a plan upgrade would lift: a plan limit (403) or the AI credits (402). */
export type PlanLimitDenial = PlanLimitError | CreditsExhaustedError;

export interface PlanLimitHit {
  /** The person who was refused. */
  readonly userId: string;
  readonly denial: PlanLimitDenial;
  /** The project the refused action is about, when there is one. */
  readonly projectId?: string;
}

/** The limit as a machine code: the limit key, or `credits.<reason>`. */
export function deniedLimitOf(denial: PlanLimitDenial): string {
  return denial instanceof PlanLimitError ? denial.details.key : `credits.${denial.details.reason}`;
}

function accountIdOf(denial: PlanLimitDenial): string | null {
  return denial.details.accountId ?? null;
}

/** `plan_limit_hit` for a refusal that the action already answered. */
export function planLimitHitEvent(hit: PlanLimitHit, plan: string): AnyProductEvent {
  const accountId = accountIdOf(hit.denial);
  const groups: AnalyticsGroups = {
    ...(accountId ? { account: accountId } : {}),
    ...(hit.projectId ? { project: hit.projectId } : {}),
  };
  return {
    name: "plan_limit_hit",
    distinctId: hit.userId,
    properties: { limit: deniedLimitOf(hit.denial), plan },
    groups,
  };
}

/**
 * The plan of the refused account. A refusal with `BILLING_ENFORCEMENT` off or
 * shadow comes from the free-plan stubs, so it is the default plan. With `on`,
 * the error names the plan, or one read of the account finds it.
 */
async function planOfDenial(env: Env, hit: PlanLimitHit): Promise<string | null> {
  if (hit.denial instanceof PlanLimitError && hit.denial.details.plan) return hit.denial.details.plan;
  const config = billingConfigFor(env);
  if (config.enforcement !== "on") return config.defaultPlan;
  const core = billingCoreFromEnv(env);
  const accountId = accountIdOf(hit.denial);
  if (accountId) return (await core.store.getAccount(accountId))?.planKey ?? null;
  return hit.projectId ? (await core.accounts.resolveBillingAccount(hit.projectId)).planKey : null;
}

/**
 * Reports a refusal in the background: the refused request answers without
 * waiting, `flush()` waits for the plan read, and a failed read sends
 * nothing. Another error is ignored.
 */
export function reportPlanLimitHit(env: Env, userId: string, cause: unknown, projectId?: string): void {
  if (!(cause instanceof PlanLimitError || cause instanceof CreditsExhaustedError)) return;
  const hit: PlanLimitHit = { userId, denial: cause, ...(projectId ? { projectId } : {}) };
  productAnalyticsOf(env).captureWhenReady(async () => {
    const plan = await planOfDenial(env, hit);
    return plan ? [planLimitHitEvent(hit, plan)] : [];
  });
}
