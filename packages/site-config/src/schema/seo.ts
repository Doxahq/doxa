import { z } from "zod";
import { plainTextSchema, requiredTextSchema } from "../primitives/plain-text";

export const seoSchema = z
  .object({
    keywords: z.array(requiredTextSchema(40)).max(20).default([]),
    twitterHandle: plainTextSchema(80).default(""),
  })
  .strict();
