import { z } from "zod";
import { siteConfigSchema } from "@doxahq/site-config";

export const recipeSchema = z
  .object({
    description: z.string().min(1),
    siteId: z.string().min(1),
    versionId: z.string().min(1),
    projectId: z.string().min(1),
    projectSlug: z.string().min(1),
    projectName: z.string().min(1),
    /** Fixed so the frozen manifest is byte-stable across runs. */
    generatedAt: z.string().datetime(),
    features: z.object({ apiPlayground: z.boolean().optional() }).optional(),
    siteConfig: siteConfigSchema.optional(),
    navigation: z
      .object({
        sections: z.array(
          z.object({
            slug: z.string().min(1),
            items: z.array(z.string()),
            groups: z
              .array(
                z.object({
                  heading: z.string().min(1),
                  items: z.array(z.string()),
                }),
              )
              .optional(),
          }),
        ),
        icons: z.record(z.string(), z.string()).optional(),
        navTitles: z.record(z.string(), z.string()).optional(),
        navBadges: z.record(z.string(), z.string()).optional(),
        sectionMetadata: z
          .record(
            z.string(),
            z.object({
              label: z.string().min(1),
              kind: z
                .enum(["documentation", "reference", "development"])
                .optional(),
              layout: z.enum(["docs", "reference"]).optional(),
            }),
          )
          .optional(),
      })
      .nullable()
      .optional(),
    pages: z
      .array(
        z.object({
          title: z.string().min(1),
          route: z.string().min(1),
          navigationPath: z.string().min(1).optional(),
          file: z.string().min(1),
        }),
      )
      .min(1),
  })
  .strict();
