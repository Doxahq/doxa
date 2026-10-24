import { z } from "zod";
import { featuresSchema } from "./schema/features";
import type { SiteConfigInput } from "./schema/site-config";
import { createDefaultSiteConfig } from "./resolve";

export const legacyV1SettingsSchema = z.object({
  projectName: z.string(),
  features: z.unknown().optional(),
});
export type LegacyV1Settings = z.input<typeof legacyV1SettingsSchema>;

export function upgradeV1SiteConfig(input: LegacyV1Settings): SiteConfigInput {
  const parsed = featuresSchema.safeParse(input.features ?? {});
  const features = parsed.success ? parsed.data : featuresSchema.parse({});
  return {
    ...createDefaultSiteConfig(input),
    features,
    branding: { poweredBy: features.branding },
  };
}
