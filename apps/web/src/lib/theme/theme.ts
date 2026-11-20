/**
 * The color theme of the Doxa app: the marketing site, the auth pages and the
 * dashboard. Dark lives in `:root`. Light sets `data-theme="light"` on <html>
 * (see `styles/globals.css`).
 *
 * The person picks a preference: "system" (the default) follows the color scheme
 * of the operating system, and "dark" or "light" fixes the theme. The preference
 * is on <html> as `data-theme-preference`, so CSS can show it on the first paint.
 *
 * The theme is an attribute and not the `.dark` class: the `dark:` variant
 * belongs to the site canvas, which follows the docs site's own theme.
 */
export const THEMES = ["dark", "light"] as const

export type Theme = (typeof THEMES)[number]

/** One value for each theme, for example the two copies of a photo. */
export type Themed<T> = Readonly<Record<Theme, T>>

/** The theme of the server render, before the head script reads the preference. */
export const DEFAULT_THEME: Theme = "dark"

export const THEME_LABELS: Record<Theme, string> = { dark: "Dark", light: "Light" }

export const THEME_PREFERENCES = ["system", "dark", "light"] as const

export type ThemePreference = (typeof THEME_PREFERENCES)[number]

export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system"

export const THEME_PREFERENCE_LABELS: Record<ThemePreference, string> = { system: "System", ...THEME_LABELS }

type ThemeListener = (theme: Theme) => void

const STORAGE_KEY = "doxa:theme"
const THEME_ATTRIBUTE = "data-theme"
const PREFERENCE_ATTRIBUTE = "data-theme-preference"
const LIGHT_SCHEME_QUERY = "(prefers-color-scheme: light)"
/** Stops every transition for the one frame in which the colors change. */
const NO_TRANSITIONS_CSS = "*,*::before,*::after{transition:none!important}"

const listeners = new Set<ThemeListener>()

export function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme === value)
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some((preference) => preference === value)
}

export function oppositeTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark"
}

/** The theme on the page now. The head script sets it before the first paint. */
export function getTheme(): Theme {
  if (typeof document === "undefined") return DEFAULT_THEME
  const value = document.documentElement.getAttribute(THEME_ATTRIBUTE)
  return isTheme(value) ? value : DEFAULT_THEME
}

/** The saved preference. The head script sets it before the first paint. */
export function getThemePreference(): ThemePreference {
  if (typeof document === "undefined") return DEFAULT_THEME_PREFERENCE
  const value = document.documentElement.getAttribute(PREFERENCE_ATTRIBUTE)
  return isThemePreference(value) ? value : DEFAULT_THEME_PREFERENCE
}

/** Fixes the theme to `theme`. To follow the system again, use `setThemePreference`. */
export function setTheme(theme: Theme): void {
  setThemePreference(theme)
}

/** Saves `preference` in this browser, shows its theme now and tells every subscriber. */
export function setThemePreference(preference: ThemePreference): void {
  writeStoredPreference(preference)
  applyPreference(preference)
}

/**
 * Calls `listener` when the theme or the preference changes, in this tab or in
 * another tab of the same browser. Returns the function that removes the listener.
 */
export function subscribeToTheme(listener: ThemeListener): () => void {
  if (listeners.size === 0) window.addEventListener("storage", onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener("storage", onStorage)
  }
}

/**
 * A head script that applies the saved preference before the first paint, so a
 * light page never flashes dark. React reads the same attributes after it mounts.
 */
export const THEME_SCRIPT = `(function(){var d=document.documentElement,p;try{p=localStorage.getItem(${JSON.stringify(STORAGE_KEY)})}catch(e){}if(${JSON.stringify(THEMES)}.indexOf(p)<0)p="system";d.setAttribute(${JSON.stringify(PREFERENCE_ATTRIBUTE)},p);d.setAttribute(${JSON.stringify(THEME_ATTRIBUTE)},p==="system"?(window.matchMedia&&matchMedia(${JSON.stringify(LIGHT_SCHEME_QUERY)}).matches?"light":"dark"):p)})()`

function systemTheme(): Theme {
  return window.matchMedia(LIGHT_SCHEME_QUERY).matches ? "light" : "dark"
}

function applyPreference(preference: ThemePreference): void {
  const theme = preference === "system" ? systemTheme() : preference
  const root = document.documentElement
  if (preference === getThemePreference() && theme === getTheme()) return
  root.setAttribute(PREFERENCE_ATTRIBUTE, preference)
  if (theme !== getTheme()) withoutTransitions(() => root.setAttribute(THEME_ATTRIBUTE, theme))
  for (const listener of listeners) listener(theme)
}

// With the "system" preference, the page follows the operating system when its color scheme changes.
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  window.matchMedia(LIGHT_SCHEME_QUERY).addEventListener("change", () => {
    if (getThemePreference() === "system") applyPreference("system")
  })
}

/**
 * Runs `change` with transitions off. Without this, each control that
 * transitions its colors fades at its own speed and the page changes in steps.
 */
function withoutTransitions(change: () => void): void {
  const style = document.createElement("style")
  style.textContent = NO_TRANSITIONS_CSS
  document.head.appendChild(style)
  change()
  // Reading a computed style makes the browser apply the new colors now,
  // while the transitions are still off.
  window.getComputedStyle(document.body).getPropertyValue("color")
  window.setTimeout(() => style.remove(), 1)
}

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY) return
  applyPreference(isThemePreference(event.newValue) ? event.newValue : DEFAULT_THEME_PREFERENCE)
}

/** "system" removes the saved value, so a later change of the default reaches this browser too. */
function writeStoredPreference(preference: ThemePreference): void {
  try {
    if (preference === DEFAULT_THEME_PREFERENCE) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}
