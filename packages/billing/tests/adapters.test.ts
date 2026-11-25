import { FREE_PLAN_SEARCH_POLICY, PAID_PLAN_SEARCH_POLICY, projectEntitlementsSchema } from "@doxahq/contracts/entitlements";
import { describe, expect, it } from "vitest";

import {
  DOXA_CATALOG,
  MAX_BRANCHES_PER_SITE_CONTRACT,
  UNLIMITED_NUMBER,
  createEntitlementAdapters,
  resolveEntitlements,
  toCustomDomainLimit,
  toHostingTier,
  toPlanSearchPolicy,
  toPlanStorageLimits,
  toProjectEntitlements,
  type PlanKey,
} from "../src/index";
import { TEST_NOW } from "../src/testing";

const forPlan = (plan: PlanKey) =>
  resolveEntitlements({ catalog: DOXA_CATALOG, defaultPlan: plan, subscription: null, overrides: [], now: TEST_NOW });

describe("entitlement adapters", () => {
  it("maps Free to the free contracts", () => {
    const free = forPlan("free");
    expect(toProjectEntitlements(free)).toEqual({ removePoweredBy: false, maxBranchesPerSite: 2 });
    expect(toPlanStorageLimits(free)).toEqual({ maxDocsStorageBytes: 20 * 1024 * 1024, maxSiteAssetBytes: 50 * 1024 * 1024, maxSiteAssetFiles: 200 });
    expect(toPlanSearchPolicy(free)).toBe(FREE_PLAN_SEARCH_POLICY);
    expect(toCustomDomainLimit(free)).toBe(1);
    expect(toHostingTier(free)).toBe("shared");
  });

  it("maps UNLIMITED to each old contract's maximum", () => {
    const pro = forPlan("pro");
    const project = toProjectEntitlements(pro);
    expect(project).toEqual({ removePoweredBy: true, maxBranchesPerSite: MAX_BRANCHES_PER_SITE_CONTRACT });
    expect(projectEntitlementsSchema.parse(project)).toEqual(project);
    expect(toPlanStorageLimits(pro).maxDocsStorageBytes).toBe(UNLIMITED_NUMBER);
    expect(toPlanSearchPolicy(pro)).toBe(PAID_PLAN_SEARCH_POLICY);
    expect(toCustomDomainLimit(pro)).toBe(4);
    expect(toCustomDomainLimit(forPlan("enterprise"))).toBe(UNLIMITED_NUMBER);
    expect(toHostingTier(pro)).toBe("dedicated");
  });

  it("builds the API seams from a project lookup", async () => {
    const adapters = createEntitlementAdapters(async (projectId) => forPlan(projectId === "p_pro" ? "pro" : "free"));
    expect(await adapters.entitlements.getProjectEntitlements("p_free")).toEqual({ removePoweredBy: false, maxBranchesPerSite: 2 });
    expect(await adapters.searchPolicy.getSearchPolicy("p_pro")).toBe(PAID_PLAN_SEARCH_POLICY);
    expect(await adapters.storageLimits.getStorageLimits("p_free")).toMatchObject({ maxSiteAssetFiles: 200 });
    expect(await adapters.docsDomainLimit.getLimit({ userId: "u", projectId: "p_pro" })).toBe(4);
    expect(await adapters.hostingTier.getHostingTier("p_free")).toBe("shared");
  });
});
