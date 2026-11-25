import { DOXA_CATALOG, systemClock, type BillingConfig, type BillingLifecycleEvents, type BillingProvider, type Clock } from "@doxahq/billing";
import { BillingPayments, BillingWebhooks, createBillingProvider } from "@doxahq/billing/payments";
import type { Env } from "../../env";
import { billingCoreFromEnv, type BillingCore } from "../../services/billing/core";
import type { BillingPaymentsBinding, BillingPaymentsRuntime } from "../../services/billing/payments-port";
import { BillingJobs, type BillingJobLog } from "./billing-jobs";
import { generationMeteringFromEnv } from "../../services/billing/generation-metering-env";
import type { GenerationMetering } from "../../services/billing/generation-metering";
import { queueHostingTierRefresh } from "../../services/billing/hosting-tier";
import { billingLifecycleAnalytics } from "../../services/billing/billing-analytics";
import { productAnalyticsOf } from "../../services/analytics/product-analytics";
import { BillingOwnershipRepository } from "../../repositories/billing-ownership";

/**
 * Payments on the Node origin (billing spec 6.2: `@doxahq/billing/payments`
 * and `/stripe` are imported only under `apps/api/src/runtime/node`).
 *
 * The provider is built once for the process from `BILLING_PROVIDER`; a
 * wrong value or a missing Stripe secret fails start-up. The store and the
 * services are built for each request or cron tick, on first use, from that
 * env's database scope.
 */
export interface NodeBillingPaymentsOptions {
  readonly config: BillingConfig;
  /** Tests pass the memory provider. */
  readonly provider?: BillingProvider;
  readonly clock?: Clock;
  /** Tests pass a core over the memory store. */
  readonly coreFor?: (env: Env) => BillingCore;
  readonly log?: BillingJobLog;
}

export function createNodeBillingPayments(options: NodeBillingPaymentsOptions): BillingPaymentsBinding {
  const clock = options.clock ?? systemClock;
  const provider = options.provider ?? createBillingProvider(options.config, { catalog: DOXA_CATALOG, clock });
  const coreFor = options.coreFor ?? billingCoreFromEnv;
  const log = options.log ?? consoleBillingLog;
  return {
    forEnv: (env) =>
      createBillingPaymentsRuntime({
        provider,
        core: () => coreFor(env),
        log,
        metering: () => generationMeteringFromEnv(env, { core: () => coreFor(env) }),
        onPlanChanged: (accountId) => queueHostingTierRefresh(env, accountId, () => coreFor(env)),
        lifecycle: () =>
          billingLifecycleAnalytics({
            analytics: () => productAnalyticsOf(env),
            ownerUserId: (accountId) => billingOwnerUserId(coreFor(env), new BillingOwnershipRepository(env), accountId),
          }),
      }),
  };
}

/** The Doxa user ID of the account owner (a team's first owner), for billing events without a signed-in user. */
async function billingOwnerUserId(
  core: BillingCore,
  contacts: Pick<BillingOwnershipRepository, "billingContactOf">,
  accountId: string,
): Promise<string | null> {
  const account = await core.store.getAccount(accountId);
  return account ? ((await contacts.billingContactOf(account))?.userId ?? null) : null;
}

/** The payments runtime of one env. Nothing is built until a method runs. */
export function createBillingPaymentsRuntime(input: {
  provider: BillingProvider;
  core: () => BillingCore;
  log: BillingJobLog;
  /** The credit meter whose sweep settles or releases holds of ended jobs (billing spec 10.5). */
  metering?: () => Pick<GenerationMetering, "sweep">;
  /** Billing spec 9.4: the account's sites take the hosting tier of the new plan. */
  onPlanChanged?: (accountId: string) => Promise<unknown>;
  /** Product analytics of the billing lifecycle (`billing-analytics.ts`). */
  lifecycle?: () => BillingLifecycleEvents;
}): BillingPaymentsRuntime {
  const { provider, log } = input;
  let built: { core: BillingCore; payments: BillingPayments; webhooks: BillingWebhooks; jobs: BillingJobs } | null = null;
  const services = () => {
    if (built) return built;
    const core = input.core();
    const count = (name: string, fields: Readonly<Record<string, string | number | boolean | null>>) => log(name, fields);
    const lifecycle = input.lifecycle?.();
    const payments = new BillingPayments({
      store: core.store,
      catalog: core.catalog,
      clock: core.clock,
      provider,
      ledger: core.ledger,
      offers: core.offers,
      entitlements: core.entitlements,
      defaultPlan: core.config.defaultPlan,
      returnBaseUrl: core.config.returnBaseUrl,
      events: {
        // Billing spec 9.4: the hosting tier of the account's sites follows the plan.
        // `queueHostingTierRefresh` queues one cache invalidation for each site of
        // the account (only with enforcement `on`), which rewrites its hostname map
        // entries with the new tier; the hostname map reconcile corrects a missed one.
        planChanged: async (event) => {
          log("billing.plan_changed", event);
          try {
            await input.onPlanChanged?.(event.accountId);
          } catch (cause) {
            // The hostname map reconcile corrects a missed write.
            log("billing.hosting_tier_refresh_failed", { accountId: event.accountId, error: cause instanceof Error ? cause.message : "unknown error" });
          }
        },
        count,
        alert: (name, fields) => log(name, { level: "error", ...fields }),
      },
      ...(lifecycle ? { lifecycle } : {}),
    });
    const webhooks = new BillingWebhooks({
      store: core.store,
      catalog: core.catalog,
      clock: core.clock,
      provider,
      payments,
      ledger: core.ledger,
      offers: core.offers,
      log: (event) => log(event.name, event.fields),
      ...(lifecycle ? { lifecycle } : {}),
    });
    built = {
      core,
      payments,
      webhooks,
      jobs: new BillingJobs({ core, payments, webhooks, provider, log, ...(input.metering ? { metering: input.metering() } : {}) }),
    };
    return built;
  };

  /** Copies the provider's state of the account's customer into the mirror. */
  const syncAccount = async (accountId: string): Promise<void> => {
    const { core, payments } = services();
    const account = await core.store.getAccount(accountId);
    if (account?.providerCustomerId && account.provider === provider.name) {
      await payments.syncCustomer({ provider: provider.name, customerId: account.providerCustomerId }, account.id);
    }
  };

  return {
    providerName: provider.name,
    createCheckout: (request) => services().payments.createCheckout(request),
    createPortalSession: (request) => services().payments.createPortalSession(request),
    async switchPlanInterval(request) {
      const { payments } = services();
      const result = await payments.switchPlanInterval(request);
      // Copy the provider's new state at once, as the Checkout return does (spec 14.2).
      await syncAccount(request.accountId);
      return result;
    },
    previewPlanInterval: (request) => services().payments.previewPlanInterval(request),
    async startProNow(request) {
      // The service syncs the account after the trial ends.
      await services().payments.startProNow(request);
    },
    previewStartProNow: (request) => services().payments.previewStartProNow(request.accountId),
    readPaymentMethod: (accountId) => services().payments.readPaymentMethod(accountId),
    listInvoices: (request) => services().payments.listInvoices(request),
    fetchCheckout: (checkoutId) => provider.fetchCheckout(checkoutId),
    syncCheckout: (checkoutId) => services().payments.syncCheckout(checkoutId),
    handleWebhook: (raw) => services().webhooks.handle(raw),
    async runScheduledJobs(scheduledTime) {
      // Self-hosted without a provider: only the credit sweep can have work,
      // and only when the meter is on; the tables may be unused.
      if (provider.name === "none") {
        await input.metering?.().sweep();
        return;
      }
      await services().jobs.run(scheduledTime);
    },
  };
}

/** Billing spec 18: structured lines in the API's usual shape. Never card data, emails or secrets. */
export const consoleBillingLog: BillingJobLog = (event, fields) => {
  const line = JSON.stringify({ service: "doxa-api", event, ...fields });
  // `level: "error"` lines (a duplicate subscription, a founder price over the cap) need an operator.
  if (fields.level === "error") console.error(line);
  else console.log(line);
};
