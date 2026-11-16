import type { Env } from "../../env";
import { BillingMeteringRepository } from "../../repositories/billing-metering";
import { billingConfigFor } from "./config";
import { billingCoreFromEnv, type BillingCore } from "./core";
import { GenerationMetering, meteringModelProvider } from "./generation-metering";
import { billingNotifierFromEnv } from "../email/notifications";

/**
 * The credit meter of one env (billing spec 10.5). With `BILLING_ENFORCEMENT=off`
 * (the default) it builds no billing core and opens no connection.
 */
export function generationMeteringFromEnv(env: Env, options: { core?: () => BillingCore } = {}): GenerationMetering {
  const { enforcement } = billingConfigFor(env);
  let built: BillingCore | null = null;
  const core = () => (built ??= (options.core ?? (() => billingCoreFromEnv(env)))());
  let repository: BillingMeteringRepository | null = null;
  const jobs = () => (repository ??= new BillingMeteringRepository(env));
  return new GenerationMetering({
    mode: enforcement,
    core,
    jobs: {
      getFacts: (jobId) => jobs().getFacts(jobId),
      usageCostUsd: (jobId) => jobs().usageCostUsd(jobId),
      recentJobIds: (projectId, limit) => jobs().recentJobIds(projectId, limit),
      addCreditsEvent: (jobId, data) => jobs().addCreditsEvent(jobId, data),
      unaccruedUsage: (jobId, since) => jobs().unaccruedUsage(jobId, since),
    },
    costs: { modelCostUsdSince: (input) => jobs().modelCostUsdSince(input) },
    modelProvider: meteringModelProvider(env.DOXA_MODEL_PROVIDER),
    // Billing spec 10.7: the credit emails, under the same enforcement mode.
    notifier: billingNotifierFromEnv(env, enforcement, (accountId) => core().store.getAccount(accountId)),
  });
}
