import {
  FREE_PLAN_SEARCH_POLICY,
  PAID_PLAN_SEARCH_POLICY,
  type PlanSearchPolicy,
} from "@doxahq/contracts/entitlements";

import type { Env } from "../../env";

const ALL_PROJECTS = "*";

export interface SearchPolicyService {
  getSearchPolicy(projectId: string): Promise<PlanSearchPolicy>;
}

/**
 * The search rules of a project's plan. Billing does not store a plan yet, so
 * an operator list marks the paid projects. When billing exists, it replaces
 * this one function. A list of `*` marks every project, for the time before
 * billing separates free and paid.
 */
export function createSearchPolicyService(
  env: Pick<Env, "DOXA_PROD_SEARCH_PAID_PROJECT_IDS">,
): SearchPolicyService {
  const paid = new Set(
    (env.DOXA_PROD_SEARCH_PAID_PROJECT_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  const everyProjectIsPaid = paid.has(ALL_PROJECTS);
  return {
    async getSearchPolicy(projectId) {
      return everyProjectIsPaid || paid.has(projectId)
        ? PAID_PLAN_SEARCH_POLICY
        : FREE_PLAN_SEARCH_POLICY;
    },
  };
}
