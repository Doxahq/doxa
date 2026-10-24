import type { ProjectEntitlements } from "@doxahq/contracts/entitlements";
import type { SiteConfigInput } from "./schema/site-config";

export function enforceEntitlements(
  config: SiteConfigInput,
  entitlements: ProjectEntitlements,
): SiteConfigInput {
  return {
    ...config,
    branding: {
      ...config.branding,
      poweredBy: entitlements.removePoweredBy
        ? (config.branding?.poweredBy ?? true)
        : true,
    },
  };
}
