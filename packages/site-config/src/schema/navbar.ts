import { z } from "zod";
import { hrefSchema } from "../primitives/href";
import { requiredTextSchema } from "../primitives/plain-text";

export const linkSchema = z
  .object({
    label: requiredTextSchema(40),
    href: hrefSchema,
    newTab: z.boolean().default(false),
  })
  .strict();

export const navbarSchema = z
  .object({
    cta: linkSchema
      .extend({
        label: requiredTextSchema(30),
        variant: z.enum(["primary", "outline"]).default("primary"),
      })
      .nullable()
      .default(null),
    links: z.array(linkSchema).max(8).default([]),
    github: hrefSchema.nullable().default(null),
  })
  .strict();
