import { StateEffect, StateField, type Extension } from "@codemirror/state"
import { EditorView, ViewPlugin } from "@codemirror/view"

import { getTheme, subscribeToTheme, type Theme } from "~/lib/theme/theme"

const setPageTheme = StateEffect.define<Theme>()

/** The page theme, as the editor knows it. */
const pageThemeField = StateField.define<Theme>({
  create: getTheme,
  update(theme, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setPageTheme)) return effect.value
    }
    return theme
  },
})

/** Sends each page theme change into the editor state. */
const pageThemeSync = ViewPlugin.define((view) => {
  const sync = (theme: Theme) => {
    if (view.state.field(pageThemeField) !== theme) view.dispatch({ effects: setPageTheme.of(theme) })
  }
  // A state can be older than the view, so the theme can change in between.
  // An editor cannot dispatch while it builds its plugins.
  queueMicrotask(() => sync(getTheme()))
  return { destroy: subscribeToTheme(sync) }
})

/**
 * Makes the editor follow the page theme. CodeMirror reads `darkTheme` to pick
 * the light or dark variant of its base styles (selection, panels, tooltips).
 * The editor themes in this folder take their colors from the page tokens, so
 * they must not fix that flag to one theme.
 */
export const pageTheme: Extension = [
  pageThemeField,
  EditorView.darkTheme.from(pageThemeField, (theme) => theme === "dark"),
  pageThemeSync,
]
