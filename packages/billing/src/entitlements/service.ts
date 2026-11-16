import type { AccountResolver } from "../accounts/resolve-account";
import type { Catalog } from "../catalog/define";
import type { PlanKey } from "../catalog/keys";
import type { Clock } from "../clock";
import type { CreditContext } from "../credits/context";
import { BillingNotFoundError } from "../errors";
import type { BillingStore } from "../store/store";
import type { BillingAccount, SubscriptionRecord } from "../store/types";
import { createEntitlementAdapters, type BillingEntitlementAdapters } from "./adapters";
import { creditContextFor, resolveEntitlements, type Entitlements } from "./resolve";

export interface AccountBillingView {
  readonly account: BillingAccount;
  readonly subscription: SubscriptionRecord | null;
  readonly entitlements: Entitlements;
  readonly creditContext: CreditContext;
}

/**
 * Reads entitlements from local state only (spec rule 1: gate on local
 * state). The API keeps one result for each request (spec 9.2).
 */
export class BillingEntitlements {
  constructor(
    private readonly deps: {
      readonly store: BillingStore;
      readonly catalog: Catalog;
      readonly clock: Clock;
      readonly defaultPlan: PlanKey;
      readonly accounts: AccountResolver;
    },
  ) {}

  async forAccount(accountId: string): Promise<AccountBillingView> {
    const state = await this.deps.store.loadAccountState(accountId);
    if (!state) throw new BillingNotFoundError(`Billing account ${accountId} does not exist.`);
    const entitlements = resolveEntitlements({
      catalog: this.deps.catalog,
      defaultPlan: this.deps.defaultPlan,
      subscription: state.subscription,
      overrides: state.overrides,
      now: this.deps.clock.now(),
    });
    return {
      account: state.account,
      subscription: state.subscription,
      entitlements,
      creditContext: creditContextFor({ catalog: this.deps.catalog, entitlements, subscription: state.subscription, account: state.account }),
    };
  }

  async forProject(projectId: string): Promise<AccountBillingView> {
    const account = await this.deps.accounts.resolveBillingAccount(projectId);
    return this.forAccount(account.id);
  }

  /** For `CreditMeter`'s `creditContext` dependency. */
  readonly creditContext = async (accountId: string): Promise<CreditContext> => (await this.forAccount(accountId)).creditContext;

  /** The API seams of spec 9.3, built on `forProject`. */
  adapters(): BillingEntitlementAdapters {
    return createEntitlementAdapters(async (projectId) => (await this.forProject(projectId)).entitlements);
  }
}
