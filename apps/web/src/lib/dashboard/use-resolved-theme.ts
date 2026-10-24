import { useMemo, useRef } from "react"
import { themeSchema, type EditableTheme, type ResolvedTheme } from "@doxahq/site-config"

export interface ResolvedThemeView {
  /** The theme as the docs site renders it. */
  resolved: ResolvedTheme
  /** The theme without token overrides: what each token inherits. */
  baseline: ResolvedTheme
}

/**
 * Resolves the theme being edited, for the preview and the placeholders.
 *
 * A half-typed value is invalid. The last valid result stays on screen until
 * the value is valid again, so the preview does not flash back to defaults.
 */
export function useResolvedTheme(theme: EditableTheme): ResolvedThemeView {
  const lastValid = useRef<ResolvedThemeView | null>(null)
  return useMemo(() => {
    const resolved = themeSchema.safeParse(theme)
    const baseline = themeSchema.safeParse({ ...theme, tokens: { light: {}, dark: {} } })
    if (resolved.success && baseline.success) {
      lastValid.current = { resolved: resolved.data, baseline: baseline.data }
    }
    if (lastValid.current) return lastValid.current
    const fallback = themeSchema.parse({})
    return { resolved: fallback, baseline: fallback }
  }, [theme])
}
