import type { z } from "zod"
import {
  createDefaultSiteConfig,
  resolveSiteConfig,
  toEditableSiteConfig,
  type EditableSiteConfig,
  type EditableTheme,
  DEFAULT_LAYOUT,
  type ResolvedLayout,
  type ResolvedTheme,
  type themeFileSchema,
} from "@doxahq/site-config"

export type ThemeFile = z.output<typeof themeFileSchema>

export function replaceItem<TItem>(items: readonly TItem[], index: number, item: TItem): TItem[] {
  return items.map((current, position) => (position === index ? item : current))
}

export function removeItem<TItem>(items: readonly TItem[], index: number): TItem[] {
  return items.filter((_, position) => position !== index)
}

/** Moves one item. An index outside the list returns an unchanged copy. */
export function moveItem<TItem>(items: readonly TItem[], from: number, to: number): TItem[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length) return [...items]
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/**
 * Changes layout values. A layout with every value at its default is
 * removed, so a site that keeps the defaults has the same config as one that
 * never chose.
 */
export function withLayout(
  config: EditableSiteConfig,
  change: Partial<ResolvedLayout>,
): EditableSiteConfig {
  const { layout: previous, ...rest } = config
  const next = { ...DEFAULT_LAYOUT, ...previous, ...change }
  const keys = Object.keys(DEFAULT_LAYOUT) as (keyof ResolvedLayout)[]
  return keys.every((key) => next[key] === DEFAULT_LAYOUT[key]) ? rest : { ...rest, layout: next }
}

/** Sets the page that the site root shows. An empty href removes the choice. */
export function withHomePage(config: EditableSiteConfig, href: string): EditableSiteConfig {
  const { homePage: _previous, ...rest } = config
  return href ? { ...rest, homePage: href } : rest
}

/**
 * Applies an uploaded theme file to the editable theme.
 *
 * The preset stays as the base for any token the file leaves out, as the spec
 * requires. The file replaces earlier overrides, so an upload gives the file's
 * look, not a mix with the colors edited before.
 */
export function applyThemeFile(theme: EditableTheme, file: ThemeFile): EditableTheme {
  const { radius, ...rest } = theme
  return {
    ...rest,
    colorMode: file.colorMode,
    fonts: { ...file.fonts },
    tokens: { light: { ...file.tokens.light }, dark: { ...file.tokens.dark } },
    ...(file.radius !== undefined ? { radius: file.radius } : radius !== undefined ? { radius } : {}),
  }
}

/** A complete `theme.json` for the resolved theme, to start a custom theme from. */
export function createThemeFile(theme: ResolvedTheme, name: string): ThemeFile {
  return {
    $schema: "https://doxa.so/schemas/theme/v1.json",
    name,
    colorMode: theme.colorMode,
    radius: theme.radius,
    fonts: { ...theme.fonts },
    tokens: { light: { ...theme.tokens.light }, dark: { ...theme.tokens.dark } },
  }
}

/**
 * The settings a new site starts with: every default, and the project name as
 * the site name. This is the config that generation writes when it gets none.
 */
export function defaultSiteSettings(projectName: string): EditableSiteConfig {
  return toEditableSiteConfig(resolveSiteConfig(createDefaultSiteConfig({ projectName })))
}
