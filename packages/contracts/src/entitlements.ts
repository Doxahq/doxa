import { z } from "zod";

import type { DocsSearchProvider } from "./docs-search";

export const projectEntitlementsSchema = z
  .object({
    removePoweredBy: z.boolean(),
    maxBranchesPerSite: z.number().int().positive().max(1000),
  })
  .strict();

export type ProjectEntitlements = z.infer<typeof projectEntitlementsSchema>;
export const FREE_PLAN_ENTITLEMENTS = {
  removePoweredBy: false,
  maxBranchesPerSite: 10,
} as const satisfies ProjectEntitlements;

/**
 * Plan storage. Kept apart from `ProjectEntitlements`, which also travels in
 * generation job messages: a new field there would break older consumers.
 */
export interface PlanStorageLimits {
  /** Bytes of one docs version, with the images that a branch adds. */
  maxDocsStorageBytes: number;
}

export const FREE_PLAN_STORAGE_LIMITS = {
  maxDocsStorageBytes: 100 * 1024 * 1024,
} as const satisfies PlanStorageLimits;

/**
 * Plan search rules. Kept apart from `ProjectEntitlements` for the same reason
 * as `PlanStorageLimits`.
 */
export interface PlanSearchPolicy {
  defaultProvider: DocsSearchProvider;
  allowedProviders: readonly DocsSearchProvider[];
}

export const FREE_PLAN_SEARCH_POLICY = {
  defaultProvider: "minisearch",
  allowedProviders: ["minisearch"],
} as const satisfies PlanSearchPolicy;

export const PAID_PLAN_SEARCH_POLICY = {
  defaultProvider: "typesense",
  allowedProviders: ["typesense", "minisearch"],
} as const satisfies PlanSearchPolicy;

/**
 * The provider a site really uses. A choice that the plan does not allow, for
 * example after a downgrade, gives the plan's default.
 */
export function resolveSearchProvider(
  choice: DocsSearchProvider | undefined,
  policy: PlanSearchPolicy,
): DocsSearchProvider {
  return choice && policy.allowedProviders.includes(choice)
    ? choice
    : policy.defaultProvider;
}
