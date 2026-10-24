import { z } from "zod";
import { plainTextSchema } from "../primitives/plain-text";
import { siteNameSchema } from "../primitives/site-name";
import { brandingSchema } from "./branding";
import { themeSchema } from "./theme";
import { navbarSchema } from "./navbar";
import { footerSchema } from "./footer";
import { seoSchema } from "./seo";
import { featuresSchema } from "./features";
import { layoutSchema } from "./layout";
import { homePageSchema } from "./home-page";

export const siteConfigSchema = z
  .object({
    $schema: z
      .literal("https://doxa.so/schemas/site-config/v1.json")
      .default("https://doxa.so/schemas/site-config/v1.json"),
    version: z.literal(1).default(1),
    name: siteNameSchema,
    description: plainTextSchema(300).default(""),
    branding: brandingSchema.prefault({}),
    theme: themeSchema.prefault({}),
    navbar: navbarSchema.prefault({}),
    footer: footerSchema.prefault({}),
    seo: seoSchema.prefault({}),
    features: featuresSchema.prefault({}),
    // Optional with no default, so a config that does not set it resolves
    // exactly as before: published sites and their golden files stay the same.
    layout: layoutSchema.optional(),
    // The href of the page that the site root shows. Optional with no
    // default: without it, the root shows the first page, as before.
    homePage: homePageSchema.optional(),
  })
  .strict();

export type SiteConfigInput = z.input<typeof siteConfigSchema>;
export type ResolvedSiteConfig = z.output<typeof siteConfigSchema>;
