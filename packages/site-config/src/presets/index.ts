import type { ThemePreset } from "../primitives/theme-preset";
import { defaultTheme } from "./default";
import { brutalistTheme } from "./brutalist";

export const THEME_PRESETS = {
  default: defaultTheme,
  brutalist: brutalistTheme,
} as const satisfies Record<string, ThemePreset>;

export type ThemePresetName = keyof typeof THEME_PRESETS;
export type { ThemePreset } from "../primitives/theme-preset";
