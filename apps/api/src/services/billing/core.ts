import {
  BillingAccountSettings,
  BillingEntitlements,
  CreditLedger,
  CreditMeter,
  DOXA_CATALOG,
  OfferSlots,
  UsageQuota,
  createAccountResolver,
  systemClock,
  type AccountResolver,
  type BillingConfig,
  type BillingStore,
  type Catalog,
  type Clock,
  type MeterEvents,
  type ProjectOwnershipPort,
} from "@doxahq/billing";
import { MODEL_PRICE_TABLE_HASH } from "@doxahq/contracts/model-prices";
import type { Env } from "../../env";
import { BillingOwnershipRepository, type BillingAccountUsage } from "../../repositories/billing-ownership";
import { billingConfigFor } from "./config";
import { createBillingStore } from "./store";

/**
 * The provider-neutral billing services of one request (billing spec 6.2:
 * `@doxahq/billing`, no provider SDK). Worker builds may use them. Payments
 * are added on the Node origin only (`runtime/node/billing.ts`).
 */
export interface BillingCore {
  readonly config: BillingConfig;
  readonly catalog: Catalog;
  readonly clock: Clock;
  readonly store: BillingStore;
  readonly projects: ProjectOwnershipPort;
  readonly usage: BillingAccountUsage;
  readonly accounts: AccountResolver;
  readonly entitlements: BillingEntitlements;
  readonly ledger: CreditLedger;
  /** The credit meter of AI runs (billing spec 10.5), over the same ledger. */
  readonly meter: CreditMeter;
  readonly offers: OfferSlots;
  readonly settings: BillingAccountSettings;
  readonly quota: UsageQuota;
  /** False for an ID the store cannot hold, so a route answers 404 before a query. */
  acceptsAccountId(id: string): boolean;
}

export interface BillingCoreDeps {
  readonly config: BillingConfig;
  readonly store: BillingStore;
  readonly projects: ProjectOwnershipPort;
  readonly usage: BillingAccountUsage;
  readonly clock?: Clock;
  readonly catalog?: Catalog;
  readonly acceptsAccountId?: (id: string) => boolean;
  /** The `credits.*` counters of billing spec 18. Default: a structured log line. */
  readonly meterEvents?: MeterEvents;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The composition of the billing core: one catalog, one clock, one store. */
export function createBillingCore(deps: BillingCoreDeps): BillingCore {
  const catalog = deps.catalog ?? DOXA_CATALOG;
  const clock = deps.clock ?? systemClock;
  const { store, config } = deps;
  const defaultPlan = config.defaultPlan;
  const accounts = createAccountResolver({ store, catalog, clock, projects: deps.projects, defaultPlan });
  const entitlements = new BillingEntitlements({ store, catalog, clock, defaultPlan, accounts });
  const ledger = new CreditLedger({ store, catalog, clock });
  const meter = new CreditMeter({
    store,
    catalog,
    clock,
    ledger,
    creditContext: entitlements.creditContext,
    priceTableHash: MODEL_PRICE_TABLE_HASH,
    events: deps.meterEvents ?? consoleMeterEvents,
  });
  return {
    config,
    catalog,
    clock,
    store,
    projects: deps.projects,
    usage: deps.usage,
    accounts,
    entitlements,
    ledger,
    meter,
    offers: new OfferSlots({ store, catalog, clock }),
    settings: new BillingAccountSettings({ store, catalog, clock }),
    quota: new UsageQuota({ store, clock }),
    acceptsAccountId: deps.acceptsAccountId ?? ((id) => UUID.test(id)),
  };
}

/** Billing spec 18: one structured line for each meter counter. */
export const consoleMeterEvents: MeterEvents = {
  count: (name, fields) => console.log(JSON.stringify({ service: "doxa-api", event: name, ...fields })),
};

/**
 * The billing core over Postgres: the composition root of the API. Building
 * it opens no connection. Callers build it only when they need billing, so
 * an env with the defaults (enforcement off, provider `none`) never touches
 * the billing tables outside the billing routes.
 */
export function billingCoreFromEnv(env: Env): BillingCore {
  const ownership = new BillingOwnershipRepository(env);
  return createBillingCore({
    config: billingConfigFor(env),
    store: createBillingStore(env),
    projects: ownership,
    usage: ownership,
  });
}
