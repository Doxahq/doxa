import {
  FREE_PLAN_SEARCH_POLICY,
  PAID_PLAN_SEARCH_POLICY,
  type PlanSearchPolicy,
  type PlanStorageLimits,
  type ProjectEntitlements,
} from "@doxahq/contracts/entitlements";

import { isUnlimited, type LimitValue } from "../catalog/define";
import type { HostingTier } from "../catalog/keys";
import type { Entitlements } from "./resolve";

/**
 * Entitlements -> the existing API seams (spec 9.3). The interfaces live in
 * `apps/api` (`EntitlementsService`, `StorageLimitsService` in
 * `services/entitlements.ts`, `SearchPolicyService` in
 * `services/docs-search/policy.ts`, `DocsDomainLimitPolicy` in
 * `services/docs-domain-limit-policy.ts`). The package does not import apps,
 * so the services below match them by shape.
 */

/** The schema maximum of `ProjectEntitlements.maxBranchesPerSite`. */
export const MAX_BRANCHES_PER_SITE_CONTRACT = 1000;

/** UNLIMITED for a plain numeric limit (bytes, files, domains). */
export const UNLIMITED_NUMBER = Number.MAX_SAFE_INTEGER;

function numberOrMax(value: LimitValue, max: number): number {
  return isUnlimited(value) ? max : Math.min(value, max);
}

export function toProjectEntitlements(entitlements: Entitlements): ProjectEntitlements {
  return {
    removePoweredBy: entitlements.features["site.remove_powered_by"],
    // The contract needs a positive integer up to 1000.
    maxBranchesPerSite: Math.max(1, numberOrMax(entitlements.limits["docs.branches_per_site"], MAX_BRANCHES_PER_SITE_CONTRACT)),
  };
}

export function toPlanStorageLimits(entitlements: Entitlements): PlanStorageLimits {
  return {
    maxDocsStorageBytes: numberOrMax(entitlements.limits["docs.storage_bytes"], UNLIMITED_NUMBER),
    maxSiteAssetBytes: numberOrMax(entitlements.limits["site.asset_bytes"], UNLIMITED_NUMBER),
    maxSiteAssetFiles: numberOrMax(entitlements.limits["site.asset_files"], UNLIMITED_NUMBER),
  };
}

export function toPlanSearchPolicy(entitlements: Entitlements): PlanSearchPolicy {
  return entitlements.features["site.typesense_search"] ? PAID_PLAN_SEARCH_POLICY : FREE_PLAN_SEARCH_POLICY;
}

export function toCustomDomainLimit(entitlements: Entitlements): number {
  return numberOrMax(entitlements.limits["site.custom_domains"], UNLIMITED_NUMBER);
}

export function toHostingTier(entitlements: Entitlements): HostingTier {
  return entitlements.hosting;
}

/** Looks up the entitlements of a project's billing account. The API wires this to the store. */
export type ProjectEntitlementsLookup = (projectId: string) => Promise<Entitlements>;

/** The shapes of the API seams, matched structurally. */
export interface BillingEntitlementAdapters {
  readonly entitlements: {
    getProjectEntitlements(projectId: string): Promise<ProjectEntitlements>;
    getSearchPolicy(projectId: string): Promise<PlanSearchPolicy>;
  };
  readonly storageLimits: { getStorageLimits(projectId: string): Promise<PlanStorageLimits> };
  readonly searchPolicy: { getSearchPolicy(projectId: string): Promise<PlanSearchPolicy> };
  readonly docsDomainLimit: { getLimit(context: { userId: string; projectId: string }): Promise<number> };
  readonly hostingTier: { getHostingTier(projectId: string): Promise<HostingTier> };
}

export function createEntitlementAdapters(lookup: ProjectEntitlementsLookup): BillingEntitlementAdapters {
  const searchPolicy = { getSearchPolicy: async (projectId: string) => toPlanSearchPolicy(await lookup(projectId)) };
  return {
    entitlements: {
      getProjectEntitlements: async (projectId) => toProjectEntitlements(await lookup(projectId)),
      getSearchPolicy: searchPolicy.getSearchPolicy,
    },
    storageLimits: { getStorageLimits: async (projectId) => toPlanStorageLimits(await lookup(projectId)) },
    searchPolicy,
    // Decision D9: the domain limit is for each account; the project finds the account.
    docsDomainLimit: { getLimit: async ({ projectId }) => toCustomDomainLimit(await lookup(projectId)) },
    hostingTier: { getHostingTier: async (projectId) => toHostingTier(await lookup(projectId)) },
  };
}
