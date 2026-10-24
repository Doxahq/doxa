import type { z } from "zod";
import type { ResolvedSiteConfig } from "./schema/site-config";
import {
  themeInputSchema,
  themeSchema,
  type ResolvedTheme,
} from "./schema/theme";
import { THEME_PRESETS } from "./presets";

type ThemeTokenValues = Readonly<Record<string, string | undefined>>;

export type EditableTheme = z.output<typeof themeInputSchema>;

/**
 * A resolved config with its theme reduced to the values a person chose.
 *
 * A resolved theme stores every token explicitly, and explicit tokens win
 * over the preset, the primary color, and the radius. An editor that works on
 * the resolved form therefore cannot change the preset or the primary color:
 * the old values stay pinned. This form keeps only real overrides, so those
 * controls work, and it resolves back to the same config.
 */
export type EditableSiteConfig = Omit<ResolvedSiteConfig, "theme"> & {
  theme: EditableTheme;
};

export function toEditableSiteConfig(
  config: ResolvedSiteConfig,
): EditableSiteConfig {
  return { ...config, theme: toEditableTheme(config.theme) };
}

export function toEditableTheme(theme: ResolvedTheme): EditableTheme {
  const preset = THEME_PRESETS[theme.preset];
  const fonts = {
    ...(theme.fonts.body !== preset.fonts.body ? { body: theme.fonts.body } : {}),
    ...(theme.fonts.code !== preset.fonts.code ? { code: theme.fonts.code } : {}),
  };
  const choices = {
    preset: theme.preset,
    defaultMode: theme.defaultMode,
    primary: theme.primary,
    fonts,
    ...(theme.colorMode !== preset.colorMode
      ? { colorMode: theme.colorMode }
      : {}),
    ...(theme.radius !== preset.light.radius ? { radius: theme.radius } : {}),
  };
  // The tokens the choices above produce on their own. Only a token that
  // differs from this baseline is an override.
  const baseline = themeSchema.parse(choices);
  return themeInputSchema.parse({
    ...choices,
    tokens: {
      light: tokenOverrides(theme.tokens.light, baseline.tokens.light),
      dark: tokenOverrides(theme.tokens.dark, baseline.tokens.dark),
    },
  });
}

function tokenOverrides(
  tokens: ThemeTokenValues,
  baseline: ThemeTokenValues,
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens)) {
    if (value !== undefined && value !== baseline[key]) overrides[key] = value;
  }
  return overrides;
}
