import { z } from "zod";
import { socialHrefSchema } from "../primitives/href";
import { requiredTextSchema } from "../primitives/plain-text";
import { linkSchema } from "./navbar";

export const footerSchema = z
  .object({
    groups: z
      .array(
        z
          .object({
            title: requiredTextSchema(40),
            links: z.array(linkSchema).max(12).default([]),
          })
          .strict(),
      )
      .max(6)
      .default([]),
    socials: z
      .object({
        x: socialHrefSchema.nullable().default(null),
        github: socialHrefSchema.nullable().default(null),
        linkedin: socialHrefSchema.nullable().default(null),
        discord: socialHrefSchema.nullable().default(null),
        youtube: socialHrefSchema.nullable().default(null),
      })
      .strict()
      .prefault({}),
  })
  .strict();
