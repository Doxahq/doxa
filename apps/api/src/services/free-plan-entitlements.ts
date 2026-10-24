import {
  FREE_PLAN_ENTITLEMENTS,
  FREE_PLAN_STORAGE_LIMITS,
} from "@doxahq/contracts/entitlements";
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
