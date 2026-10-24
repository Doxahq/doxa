import { z } from "zod";

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
