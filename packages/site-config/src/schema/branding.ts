import { z } from "zod";
import { assetRefSchema } from "../primitives/asset-ref";
import { hrefSchema } from "../primitives/href";

export const brandingSchema = z
  .object({
    logo: z
      .object({
        light: assetRefSchema.nullable().default(null),
        dark: assetRefSchema.nullable().default(null),
        href: hrefSchema.default("/"),
      })
      .strict()
      .prefault({}),
    favicon: assetRefSchema.nullable().default(null),
    ogImage: assetRefSchema.nullable().default(null),
    poweredBy: z.boolean().default(true),
  })
  .strict();
