import { useState } from "react"
import { ChevronDown, RotateCcw } from "lucide-react"
import { THEME_TOKEN_CSS_VARIABLES, type ResolvedTheme, type ThemeTokenKey } from "@doxahq/site-config"

import { Button } from "~/components/ui/button"
import { ColorInput } from "~/components/dashboard/content/site-settings/fields/color-token-field"
import { SegmentedControl } from "~/components/dashboard/content/site-settings/fields/controls"
import { ValidatedField } from "~/components/dashboard/content/site-settings/fields/validated-field"
import { useSiteSettingsContext } from "~/components/dashboard/content/site-settings/site-settings-context"
import { issuesWithin } from "~/lib/dashboard/site-settings-issues"
import { cn } from "~/lib/utils"

type TokenMode = "light" | "dark"

/** Radius has its own control. Every other token is a color. */
const COLOR_TOKENS = Object.keys(THEME_TOKEN_CSS_VARIABLES).filter(
  (key): key is Exclude<ThemeTokenKey, "radius"> => key !== "radius",
)

/** "sidebarPrimaryForeground" → "Sidebar primary foreground". */
function tokenLabel(key: string): string {
  const words = key.replace(/([a-z])([A-Z\d])/g, "$1 $2").toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function ThemeTokenOverrides({ baseline }: { baseline: ResolvedTheme }) {
  const { state } = useSiteSettingsContext()
  const { theme } = state.config
  const isDarkOnly = (theme.colorMode ?? baseline.colorMode) === "dark-only"
  const overrideCount = Object.keys(theme.tokens.light).length + Object.keys(theme.tokens.dark).length
  const hasTokenIssues = issuesWithin(state.issues, "/theme/tokens").length > 0
  const [isOpen, setIsOpen] = useState(overrideCount > 0 || hasTokenIssues)
  const [chosenMode, setMode] = useState<TokenMode>("light")
  const mode: TokenMode = isDarkOnly ? "light" : chosenMode

  const setToken = (key: string, value: string | undefined) =>
    state.update((current) => {
      const { [key]: _removed, ...rest } = current.theme.tokens[mode]
      const tokens = { ...current.theme.tokens, [mode]: value === undefined ? rest : { ...rest, [key]: value } }
      return { ...current, theme: { ...current.theme, tokens } }
    })
  const resetAll = () =>
    state.update((current) => ({ ...current, theme: { ...current.theme, tokens: { light: {}, dark: {} } } }))

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left focus-visible:-outline-offset-2"
      >
        <span className="space-y-0.5">
          <span className="block text-sm font-medium">Custom colors</span>
          <span className="block text-xs text-muted-foreground">
            {overrideCount === 0 ? "Every color comes from the preset." : `${overrideCount} color${overrideCount === 1 ? "" : "s"} changed from the preset.`}
          </span>
        </span>
        <ChevronDown aria-hidden="true" className={cn("size-4 text-muted-foreground transition-transform", isOpen && "rotate-180")} />
      </button>
      {isOpen ? (
        <div className="space-y-4 border-t border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {isDarkOnly ? (
              <span className="text-xs text-muted-foreground">This theme is dark only, so it has one set of colors.</span>
            ) : (
              <SegmentedControl
                label="Color mode to edit"
                value={chosenMode}
                options={[
                  { value: "light", label: "Light mode" },
                  { value: "dark", label: "Dark mode" },
                ]}
                onValueChange={setMode}
              />
            )}
            <Button type="button" variant="ghost" size="sm" disabled={overrideCount === 0} onClick={resetAll}>
              <RotateCcw aria-hidden="true" />
              Use preset colors
            </Button>
          </div>
          <div className="grid gap-x-5 gap-y-4 md:grid-cols-2">
            {COLOR_TOKENS.map((key) => (
              <ValidatedField key={`${mode}:${key}`} pointer={`/theme/tokens/${mode}/${key}`} label={tokenLabel(key)}>
                {(control) => (
                  <ColorInput
                    {...control}
                    label={tokenLabel(key).toLowerCase()}
                    value={theme.tokens[mode][key]}
                    inherited={baseline.tokens[mode][key] ?? ""}
                    onValueChange={(value) => setToken(key, value)}
                  />
                )}
              </ValidatedField>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
