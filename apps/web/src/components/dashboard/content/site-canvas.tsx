import { useMemo, type CSSProperties, type ReactNode } from "react"
import { fontStylesheetHref, themeCssVariables, type ResolvedTheme } from "@doxahq/site-config"

import { canvasPresetCss, SITE_CANVAS_CLASS, type CanvasMode } from "~/lib/dashboard/site-canvas"
import { cn } from "~/lib/utils"

/**
 * A region drawn with the docs site's theme instead of the dashboard's.
 *
 * The site theme and the dashboard use the same CSS variable names, and the
 * shared prose components read those variables. Setting the site's values on
 * this element restyles only its subtree. They are set through the CSSOM (the
 * `style` object), never as a stylesheet string, so no config value can reach
 * a style rule. The `dark` class turns on the same `dark:` variants and dark
 * prose rules the published site uses in dark mode.
 *
 * The focus ring is the one site token the canvas does not take. Focus
 * outlines are editor chrome, so they stay the dashboard's blue.
 *
 * Editor chrome (menus, toolbars) must render outside this element, or it
 * takes the site's colors. Chrome that must sit inside it, such as the outline
 * of a selected block, reads `--dashboard-primary` and not `--primary`.
 */
export function SiteCanvas({
  theme,
  mode,
  className,
  children,
}: {
  theme: ResolvedTheme
  mode: CanvasMode
  className?: string
  children: ReactNode
}) {
  const style = useMemo(
    () => ({ ...themeCssVariables(theme, mode), "--ring": "var(--dashboard-primary)" }) as CSSProperties,
    [mode, theme],
  )
  // Preset rules are code in `@doxahq/site-config`, not config values.
  const presetCss = useMemo(() => canvasPresetCss(theme), [theme])
  const fontHref = fontStylesheetHref(theme)

  return (
    <div className={cn(SITE_CANVAS_CLASS, mode === "dark" && "dark", className)} style={style}>
      {presetCss ? <style>{presetCss}</style> : null}
      {fontHref ? <link rel="stylesheet" href={fontHref} /> : null}
      {children}
    </div>
  )
}
