import { useCallback, useSyncExternalStore } from "react"

import {
  DEFAULT_THEME,
  DEFAULT_THEME_PREFERENCE,
  getTheme,
  getThemePreference,
  oppositeTheme,
  setTheme,
  setThemePreference,
  subscribeToTheme,
  type Theme,
  type ThemePreference,
} from "~/lib/theme/theme"

export type ThemeControls = {
  /** The theme on the page: the preference, or the system theme for "system". */
  theme: Theme
  preference: ThemePreference
  setTheme: (theme: Theme) => void
  setPreference: (preference: ThemePreference) => void
  toggleTheme: () => void
}

function getServerTheme(): Theme {
  return DEFAULT_THEME
}

function getServerPreference(): ThemePreference {
  return DEFAULT_THEME_PREFERENCE
}

/**
 * The page theme and the functions that change it. The server and the first
 * client render use the default theme, then the hook reads the theme that the
 * head script applied. Markup that must be right on the first paint, such as
 * an icon for the current theme, must use CSS on `[data-theme]` instead.
 */
export function useTheme(): ThemeControls {
  const theme = useSyncExternalStore(subscribeToTheme, getTheme, getServerTheme)
  const preference = useSyncExternalStore(subscribeToTheme, getThemePreference, getServerPreference)
  const toggleTheme = useCallback(() => setTheme(oppositeTheme(getTheme())), [])
  return { theme, preference, setTheme, setPreference: setThemePreference, toggleTheme }
}
