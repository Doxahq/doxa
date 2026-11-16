import type { ProjectBilling } from "@doxahq/contracts/billing";
import type { Env } from "../../env";
import { billingConfigFor, isBillingActive } from "./config";
import { billingCoreFromEnv, type BillingCore } from "./core";

/**
 * `billing` of `GET /projects/:projectId` (billing spec 15.1): the account
 * that pays for the project and its effective plan, so the shell can show
 * limits without a second request. `enforcement` tells the dashboard
 * whether to gate: only `on` does.
 *
 * Null while billing is not active (the defaults: provider `none`,
 * enforcement `off`), so the project read never touches the billing tables
 * before they are in use. A billing error is logged and gives null: the
 * project page must not fail because of billing.
 */
export async function readProjectBilling(
  env: Env,
  projectId: string,
  coreFor: (env: Env) => BillingCore = billingCoreFromEnv,
): Promise<ProjectBilling | null> {
  const config = billingConfigFor(env);
  if (!isBillingActive(config)) return null;
  try {
    const view = await coreFor(env).entitlements.forProject(projectId);
    // The dashboard gates only when `enforcement` is `on`.
    return { accountId: view.account.id, plan: view.entitlements.plan, enforcement: config.enforcement };
  } catch (cause) {
    const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error";
    console.warn(JSON.stringify({ service: "doxa-api", event: "billing.project_read_failed", projectId, message }));
    return null;
  }
}
