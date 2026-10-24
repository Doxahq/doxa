import { useState } from "react"
import type { DocsContentOverviewDto } from "@doxahq/contracts"
import { scopeCss, THEME_PRESETS, themeSchema, type ResolvedTheme, type ThemePreset } from "@doxahq/site-config"

/**
 * The site canvas: the region of the content editor that the docs site's own
 * theme draws, so a page is written with the colors, fonts and radius it is
 * published with.
 */

export type CanvasMode = "light" | "dark"

/** The class on the canvas element. The canvas styles in `globals.css` use it. */
export const SITE_CANVAS_CLASS = "doxa-site-canvas"

const FALLBACK_THEME = themeSchema.parse({})

/**
 * The theme of the branch being edited. The working config holds every
 * settings change: the settings pages save it within a second of an edit and
 * before they close. A config that does not parse falls back to the default.
 */
export function siteCanvasTheme(siteConfig: DocsContentOverviewDto["siteConfig"] | null): ResolvedTheme {
  const config = siteConfig ? (siteConfig.working ?? siteConfig.published) : null
  const parsed = themeSchema.safeParse(config?.theme)
  return parsed.success ? parsed.data : FALLBACK_THEME
}

/** A dark-only site has no light mode to switch to. */
export function hasLightMode(theme: ResolvedTheme): boolean {
  return theme.colorMode !== "dark-only"
}

/** The preset's own rules (patterns, selection color), limited to the canvas. */
export function canvasPresetCss(theme: ResolvedTheme): string {
  const preset: ThemePreset = THEME_PRESETS[theme.preset]
  const css = preset.extraCss
  return css ? scopeCss(css, `.${SITE_CANVAS_CLASS}`) : ""
}

/**
 * The mode the canvas shows. It starts dark, to match the dashboard around
 * it, whatever mode the site opens in for readers. The author can switch it.
 * A dark-only site stays dark.
 */
export function useCanvasMode(theme: ResolvedTheme): [CanvasMode, (mode: CanvasMode) => void] {
  const [choice, setChoice] = useState<CanvasMode>("dark")
  return [hasLightMode(theme) ? choice : "dark", setChoice]
}

/** The site theme of the editor canvases and their shared Light/Dark mode. */
export interface CanvasSettings {
  theme: ResolvedTheme
  mode: CanvasMode
  onModeChange: (mode: CanvasMode) => void
}
