import type { Catalog } from "../catalog/define";
import type { PlanKey } from "../catalog/keys";
import type { Clock } from "../clock";
import { BillingNotFoundError } from "../errors";
import type { BillingStore } from "../store/store";
import type { BillingAccount, OwnerKind } from "../store/types";

/**
 * Who pays for a project (spec 8.1, decision D1): its team's account when it
 * has a team, else its owner's personal account. `resolveBillingAccount` is
 * the only function that answers this question.
 */

/** The API implements this port from the `projects` table. */
export interface ProjectOwnershipPort {
  getProjectOwnership(projectId: string): Promise<{ readonly userId: string; readonly teamId: string | null } | null>;
}

export interface AccountResolverDeps {
  readonly store: BillingStore;
  readonly catalog: Catalog;
  readonly clock: Clock;
  readonly projects: ProjectOwnershipPort;
  /** `BILLING_DEFAULT_PLAN`, the cached plan of a new account. */
  readonly defaultPlan: PlanKey;
}

export interface AccountResolver {
  /** The billing account of a project. Creates the owner's account on first use. */
  resolveBillingAccount(projectId: string): Promise<BillingAccount>;
  /** The personal account of a user, or the account of a team. Creates it on first use. */
  accountForOwner(ownerKind: OwnerKind, ownerId: string): Promise<BillingAccount>;
}

export function createAccountResolver(deps: AccountResolverDeps): AccountResolver {
  const accountForOwner = (ownerKind: OwnerKind, ownerId: string) =>
    deps.store.ensureAccount({
      ownerKind,
      ownerId,
      planKey: deps.defaultPlan,
      // Pay-as-you-go is on by default for paid accounts (D16). The plan's
      // `ai.payg` feature and the trial rule decide whether it applies.
      paygEnabled: deps.catalog.payg.defaultOn,
      paygMonthlyLimitCents: deps.catalog.payg.defaultMonthlyLimitCents,
      now: deps.clock.now(),
    });
  return {
    accountForOwner,
    async resolveBillingAccount(projectId) {
      const owner = await deps.projects.getProjectOwnership(projectId);
      if (!owner) throw new BillingNotFoundError(`Project ${projectId} does not exist.`);
      return owner.teamId ? accountForOwner("team", owner.teamId) : accountForOwner("user", owner.userId);
    },
  };
}
