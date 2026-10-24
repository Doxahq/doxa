import { z } from "zod";
import { cssColorSchema } from "../primitives/css-color";
import { cssLengthSchema } from "../primitives/css-length";
import { fontFamilySchema } from "../primitives/font-family";
import {
  themeTokensSchema,
  themeTokenOverridesSchema,
} from "../primitives/theme-tokens";
import { plainTextSchema } from "../primitives/plain-text";
import {
  THEME_PRESETS,
  type ThemePreset,
  type ThemePresetName,
} from "../presets";

const fontsSchema = z
  .object({
    body: fontFamilySchema.optional(),
    code: fontFamilySchema.optional(),
  })
  .strict();
const tokensSchema = z
  .object({
    light: themeTokenOverridesSchema.prefault({}),
    dark: themeTokenOverridesSchema.prefault({}),
  })
  .strict();

export const themeInputSchema = z
  .object({
    preset: z
      .enum(Object.keys(THEME_PRESETS))
      .refine(
        (value): value is ThemePresetName =>
          Object.hasOwn(THEME_PRESETS, value),
        { params: { siteConfigCode: "unknown_preset" } },
      )
      .default("default"),
    defaultMode: z.enum(["system", "light", "dark"]).default("system"),
    colorMode: z.enum(["light-dark", "dark-only"]).optional(),
    primary: cssColorSchema.nullable().default(null),
    radius: cssLengthSchema.optional(),
    fonts: fontsSchema.prefault({}),
    tokens: tokensSchema.prefault({}),
  })
  .strict();

function resolveTheme(input: z.output<typeof themeInputSchema>) {
  const preset: ThemePreset = THEME_PRESETS[input.preset];
  const radius = input.radius ?? preset.light.radius;
  const primary = input.primary === null ? {} : { primary: input.primary };
  return {
    ...input,
    colorMode: input.colorMode ?? preset.colorMode,
    radius,
    fonts: { ...preset.fonts, ...input.fonts },
    tokens: {
      light: themeTokensSchema.parse({
        ...preset.light,
        ...primary,
        radius,
        ...definedTokens(input.tokens.light),
      }),
      dark: themeTokensSchema.parse({
        ...(preset.dark ?? preset.light),
        ...primary,
        radius,
        ...definedTokens(input.tokens.dark),
      }),
    },
  };
}

function definedTokens(tokens: z.output<typeof themeTokenOverridesSchema>) {
  return Object.fromEntries(
    Object.entries(tokens).filter(([, value]) => value !== undefined),
  );
}

export const themeSchema = themeInputSchema.transform(resolveTheme);
export type ResolvedTheme = z.output<typeof themeSchema>;

export const themeFileSchema = z
  .object({
    $schema: z.literal("https://doxa.so/schemas/theme/v1.json").optional(),
    name: plainTextSchema(80).default("Custom theme"),
    colorMode: z.enum(["light-dark", "dark-only"]).default("light-dark"),
    radius: cssLengthSchema.optional(),
    fonts: fontsSchema.prefault({}),
    tokens: tokensSchema.prefault({}),
  })
  .strict();
