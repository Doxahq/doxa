import type {
  PlanSearchPolicy,
  PlanStorageLimits,
  ProjectEntitlements,
} from "@doxahq/contracts/entitlements";

export interface EntitlementsService {
  getProjectEntitlements(projectId: string): Promise<ProjectEntitlements>;
  /** Absent means the free plan's search rules. */
  getSearchPolicy?(projectId: string): Promise<PlanSearchPolicy>;
}

export interface StorageLimitsService {
  getStorageLimits(projectId: string): Promise<PlanStorageLimits>;
}
