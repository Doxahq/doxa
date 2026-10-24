import { RotateCcw } from "lucide-react"
import { FONT_CATALOG, THEME_PRESETS, type EditableTheme, type ThemePresetName } from "@doxahq/site-config"

import { Button } from "~/components/ui/button"
import { ColorInput } from "~/components/dashboard/content/site-settings/fields/color-token-field"
import {
  onRadioGroupKeyDown,
  SegmentedControl,
  Select,
  SettingsSection,
  TextInput,
} from "~/components/dashboard/content/site-settings/fields/controls"
import { ValidatedField } from "~/components/dashboard/content/site-settings/fields/validated-field"
import { useSiteSettingsContext } from "~/components/dashboard/content/site-settings/site-settings-context"
import { ThemeFileControls } from "~/components/dashboard/content/site-settings/tabs/theme-file-controls"
import { ThemePreview } from "~/components/dashboard/content/site-settings/tabs/theme-preview"
import { ThemeTokenOverrides } from "~/components/dashboard/content/site-settings/tabs/theme-token-overrides"
import { fieldIdForPointer } from "~/lib/dashboard/site-settings-issues"
import { useResolvedTheme } from "~/lib/dashboard/use-resolved-theme"
import { cn } from "~/lib/utils"

const PRESET_NAMES = Object.keys(THEME_PRESETS).filter((name): name is ThemePresetName =>
  Object.hasOwn(THEME_PRESETS, name),
)
const FONT_NAMES = Object.keys(FONT_CATALOG)
const RADIUS_SUGGESTIONS = ["0", "2px", "4px", "0.375rem", "0.5rem", "0.625rem", "0.75rem", "1rem"]

export function ThemeTab() {
  const { state } = useSiteSettingsContext()
  const { theme } = state.config
  const { resolved, baseline } = useResolvedTheme(theme)
  const setTheme = (recipe: (current: EditableTheme) => EditableTheme) =>
    state.update((current) => ({ ...current, theme: recipe(current.theme) }))
  const preset = THEME_PRESETS[theme.preset]

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-8">
        <SettingsSection title="Preset" description="A complete theme to start from. Every choice below changes the preset.">
          <div role="radiogroup" aria-label="Theme preset" id={fieldIdForPointer("/theme/preset")} className="grid gap-3 sm:grid-cols-2">
            {PRESET_NAMES.map((name) => {
              const option = THEME_PRESETS[name]
              const selected = theme.preset === name
              const swatches = [option.light.background, option.light.foreground, option.light.primary, option.light.muted]
              return (
                <button
                  key={name}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setTheme((current) => ({ ...current, preset: name }))}
                  onKeyDown={(event) =>
                    onRadioGroupKeyDown(event, PRESET_NAMES, theme.preset, (preset) =>
                      setTheme((current) => ({ ...current, preset })),
                    )
                  }
                  className={cn(
                    "flex items-center gap-3 rounded-lg border p-3 text-left transition-colors",
                    selected ? "border-primary bg-primary/5" : "border-border hover:border-foreground/30",
                  )}
                >
                  <span className="flex shrink-0 overflow-hidden rounded-sm border border-border" aria-hidden="true">
                    {swatches.map((color, index) => (
                      <span key={index} className="block size-5" style={{ backgroundColor: color }} />
                    ))}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{option.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {option.colorMode === "dark-only" ? "Dark only" : "Light and dark"}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </SettingsSection>

        <SettingsSection title="Color">
          <div className="grid gap-5 md:grid-cols-2">
            <ValidatedField
              pointer="/theme/primary"
              label="Primary color"
              description="Buttons, links, and the active page. It applies to both modes."
            >
              {(control) => (
                <ColorInput
                  {...control}
                  label="primary color"
                  value={theme.primary ?? undefined}
                  inherited={preset.light.primary}
                  onValueChange={(primary) => setTheme((current) => ({ ...current, primary: primary ?? null }))}
                />
              )}
            </ValidatedField>
            <ValidatedField pointer="/theme/colorMode" label="Color modes">
              {(control) => (
                <Select
                  {...control}
                  value={theme.colorMode ?? "preset"}
                  options={[
                    { value: "preset", label: `Preset (${preset.colorMode === "dark-only" ? "dark only" : "light and dark"})` },
                    { value: "light-dark", label: "Light and dark" },
                    { value: "dark-only", label: "Dark only" },
                  ]}
                  onValueChange={(value) =>
                    setTheme(({ colorMode: _previous, ...current }) =>
                      value === "preset" ? current : { ...current, colorMode: value },
                    )
                  }
                />
              )}
            </ValidatedField>
            <ValidatedField
              pointer="/theme/defaultMode"
              label="Default mode"
              description={resolved.colorMode === "dark-only" ? "The theme is dark only, so readers always see dark mode." : "Readers can still switch modes."}
            >
              {(control) => (
                <SegmentedControl
                  id={control.id}
                  label="Default mode"
                  value={theme.defaultMode}
                  options={[
                    { value: "system", label: "System" },
                    { value: "light", label: "Light" },
                    { value: "dark", label: "Dark" },
                  ]}
                  onValueChange={(defaultMode) => setTheme((current) => ({ ...current, defaultMode }))}
                />
              )}
            </ValidatedField>
            <ValidatedField
              pointer="/theme/radius"
              label="Corner radius"
              description="0 for sharp corners. Up to 4rem or 64px."
              actions={
                theme.radius !== undefined ? (
                  <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setTheme(({ radius: _radius, ...current }) => current)}>
                    <RotateCcw aria-hidden="true" className="size-3" />
                    Preset
                  </Button>
                ) : null
              }
            >
              {(control) => (
                <>
                  <TextInput
                    {...control}
                    list="site-settings-radius"
                    value={theme.radius ?? ""}
                    placeholder={preset.light.radius}
                    onValueChange={(radius) =>
                      setTheme(({ radius: _previous, ...current }) =>
                        radius.trim() === "" ? current : { ...current, radius },
                      )
                    }
                    className="font-mono text-xs"
                    spellCheck={false}
                  />
                  <datalist id="site-settings-radius">
                    {RADIUS_SUGGESTIONS.map((value) => (
                      <option key={value} value={value} />
                    ))}
                  </datalist>
                </>
              )}
            </ValidatedField>
          </div>
        </SettingsSection>

        <SettingsSection title="Fonts">
          <div className="grid gap-5 md:grid-cols-2">
            {(["body", "code"] as const).map((slot) => (
              <ValidatedField key={slot} pointer={`/theme/fonts/${slot}`} label={slot === "body" ? "Body font" : "Code font"}>
                {(control) => (
                  <Select
                    {...control}
                    value={theme.fonts[slot] ?? "preset"}
                    options={[
                      { value: "preset", label: `Preset (${preset.fonts[slot]})` },
                      ...FONT_NAMES.map((name) => ({ value: name, label: name })),
                    ]}
                    onValueChange={(value) =>
                      setTheme((current) => {
                        const { [slot]: _previous, ...fonts } = current.fonts
                        return { ...current, fonts: value === "preset" ? fonts : { ...fonts, [slot]: value } }
                      })
                    }
                  />
                )}
              </ValidatedField>
            ))}
          </div>
        </SettingsSection>

        <SettingsSection title="Advanced">
          <ThemeTokenOverrides baseline={baseline} />
        </SettingsSection>

        <SettingsSection title="Theme file" description="Share a theme between sites, or build one outside Doxa. The file follows the theme JSON schema.">
          <ThemeFileControls resolved={resolved} />
        </SettingsSection>
      </div>

      <aside className="xl:sticky xl:top-0 xl:self-start">
        <ThemePreview theme={resolved} config={state.config} />
      </aside>
    </div>
  )
}
