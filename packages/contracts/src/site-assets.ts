import { z } from "zod";
import {
  assetRefSchema,
  siteAssetContentTypeSchema,
} from "@doxahq/site-config";
import { validationIssueSchema } from "./validation";

export const siteAssetUploadResponseSchema = z
  .object({
    ref: assetRefSchema,
    contentType: siteAssetContentTypeSchema,
    size: z.number().int().positive(),
    warnings: z.array(validationIssueSchema).optional(),
  })
  .strict();
export type SiteAssetUploadResponse = z.infer<
  typeof siteAssetUploadResponseSchema
>;
