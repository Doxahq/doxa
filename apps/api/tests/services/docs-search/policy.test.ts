import {
  FREE_PLAN_SEARCH_POLICY,
  PAID_PLAN_SEARCH_POLICY,
} from "@doxahq/contracts/entitlements";
import { describe, expect, it } from "vitest";

import { createSearchPolicyService } from "../../../src/services/docs-search/policy";

const policyOf = (list: string | undefined, projectId: string) =>
  createSearchPolicyService({
    DOXA_PROD_SEARCH_PAID_PROJECT_IDS: list,
  }).getSearchPolicy(projectId);

describe("createSearchPolicyService", () => {
  it("gives the free rules when the list is not set", async () => {
    await expect(policyOf(undefined, "p1")).resolves.toEqual(
      FREE_PLAN_SEARCH_POLICY,
    );
  });

  it("gives the paid rules only to the listed projects", async () => {
    await expect(policyOf("p1, p2", "p2")).resolves.toEqual(
      PAID_PLAN_SEARCH_POLICY,
    );
    await expect(policyOf("p1, p2", "p3")).resolves.toEqual(
      FREE_PLAN_SEARCH_POLICY,
    );
  });

  it("gives the paid rules to every project when the list is *", async () => {
    await expect(policyOf("*", "any-project")).resolves.toEqual(
      PAID_PLAN_SEARCH_POLICY,
    );
  });
});
