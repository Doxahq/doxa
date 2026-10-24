import type {
  PlanStorageLimits,
  ProjectEntitlements,
} from "@doxahq/contracts/entitlements";

export interface EntitlementsService {
  getProjectEntitlements(projectId: string): Promise<ProjectEntitlements>;
}

export interface StorageLimitsService {
  getStorageLimits(projectId: string): Promise<PlanStorageLimits>;
}
