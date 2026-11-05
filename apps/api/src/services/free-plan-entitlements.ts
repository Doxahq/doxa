import {
  FREE_PLAN_ENTITLEMENTS,
  FREE_PLAN_STORAGE_LIMITS,
} from "@doxahq/contracts/entitlements";
import type { Env } from "../env";
import { createSearchPolicyService } from "./docs-search/policy";
import type { EntitlementsService, StorageLimitsService } from "./entitlements";

export const freePlanEntitlements: EntitlementsService = {
  async getProjectEntitlements() {
    return { ...FREE_PLAN_ENTITLEMENTS };
  },
};

export const freePlanStorageLimits: StorageLimitsService = {
  async getStorageLimits() {
    return { ...FREE_PLAN_STORAGE_LIMITS };
  },
};

/** The free plan's limits, with the search rules that this deployment sets. */
export function createEntitlements(
  env: Pick<Env, "DOXA_PROD_SEARCH_PAID_PROJECT_IDS">,
): EntitlementsService {
  const search = createSearchPolicyService(env);
  return {
    ...freePlanEntitlements,
    getSearchPolicy: (projectId) => search.getSearchPolicy(projectId),
  };
}
