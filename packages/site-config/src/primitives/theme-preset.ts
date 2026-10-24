import { z } from "zod";
import { themeTokensSchema } from "./theme-tokens";
import { fontFamilySchema } from "./font-family";

export const themePresetSchema = z
  .object({
    name: z.string(),
    colorMode: z.enum(["light-dark", "dark-only"]),
    light: themeTokensSchema,
    dark: themeTokensSchema.optional(),
    fonts: z
      .object({ body: fontFamilySchema, code: fontFamilySchema })
      .strict(),
    extraCss: z.string().optional(),
  })
  .strict();

export type ThemePreset = z.infer<typeof themePresetSchema>;
