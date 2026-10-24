import { z } from "zod";

export const assetRefSchema = z
  .string()
  .refine(
    (value) => value.length === 70 && /^asset:[a-f0-9]{64}$/.test(value),
    { params: { siteConfigCode: "invalid_asset_ref" } },
  );

export type AssetRef = z.infer<typeof assetRefSchema>;
