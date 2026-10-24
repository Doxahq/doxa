import { useEffect, useRef, useState } from "react"
import {
  FONT_CATALOG,
  THEME_TOKEN_CSS_VARIABLES,
  type EditableSiteConfig,
  type ResolvedTheme,
} from "@doxahq/site-config"

import { SegmentedControl } from "~/components/dashboard/content/site-settings/fields/controls"
import { cn } from "~/lib/utils"

type PreviewMode = "light" | "dark"

/**
 * A small docs page drawn with the theme being edited.
 *
 * The theme tokens use the same CSS variable names as the dashboard, and the
 * dashboard utilities read those variables. Setting them on this container
 * restyles only its subtree. They are set through the CSSOM, never as a
 * stylesheet string, so no value can reach a style rule.
 */
export function ThemePreview({
  theme,
  config,
}: {
  theme: ResolvedTheme
  config: Pick<EditableSiteConfig, "name" | "navbar">
}) {
  const isDarkOnly = theme.colorMode === "dark-only"
  const [mode, setMode] = useState<PreviewMode>(theme.defaultMode === "light" ? "light" : "dark")
  const shownMode: PreviewMode = isDarkOnly ? "dark" : mode
  // A dark-only theme renders its light tokens in both modes.
  const tokens = shownMode === "dark" && !isDarkOnly ? theme.tokens.dark : theme.tokens.light
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    for (const [key, variable] of Object.entries(THEME_TOKEN_CSS_VARIABLES)) {
      const value = tokens[key]
      if (value) element.style.setProperty(variable, value)
    }
    const bodyFont = Object.entries(FONT_CATALOG).find(([name]) => name === theme.fonts.body)?.[1]
    const codeFont = Object.entries(FONT_CATALOG).find(([name]) => name === theme.fonts.code)?.[1]
    if (bodyFont) element.style.setProperty("font-family", bodyFont.css)
    if (codeFont) element.style.setProperty("--preview-code-font", codeFont.css)
  }, [theme.fonts.body, theme.fonts.code, tokens])

  const links = config.navbar.links.slice(0, 3)
  const cta = config.navbar.cta

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">Preview</span>
        {isDarkOnly ? (
          <span className="text-xs text-muted-foreground">This theme is dark only.</span>
        ) : (
          <SegmentedControl
            label="Preview mode"
            value={mode}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            onValueChange={setMode}
          />
        )}
      </div>
      <div
        ref={containerRef}
        aria-label={`Theme preview, ${shownMode} mode`}
        role="img"
        className="overflow-hidden rounded-lg border border-border bg-background text-foreground"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <span className="truncate text-sm font-semibold">{config.name || "Documentation"}</span>
          <div className="flex min-w-0 items-center gap-3">
            {links.map((link, index) => (
              <span key={index} className="hidden truncate text-xs text-muted-foreground sm:inline">
                {link.label || "Link"}
              </span>
            ))}
            {cta ? (
              <span
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium",
                  cta.variant === "primary"
                    ? "bg-primary text-primary-foreground"
                    : "rounded-md border border-border text-foreground",
                )}
              >
                {cta.label || "Button"}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex">
          <div className="hidden w-28 shrink-0 space-y-1.5 border-r border-border bg-sidebar p-3 text-xs text-sidebar-foreground sm:block">
            <div className="font-medium text-sidebar-primary">Introduction</div>
            <div>Installation</div>
            <div>Configuration</div>
          </div>
          <div className="min-w-0 flex-1 space-y-3 p-4">
            <div className="text-base font-semibold">Getting started</div>
            <p className="text-xs leading-5 text-muted-foreground">
              Install the package, then call <code className="rounded-sm border border-(--code-border) bg-(--code-bg) px-1 text-(--code-fg)">init()</code> once.
            </p>
            <pre
              className="overflow-hidden rounded-md border border-(--code-border) bg-(--code-bg) p-3 text-[11px] leading-5 text-(--code-fg)"
              style={{ fontFamily: "var(--preview-code-font)" }}
            >
              {"npm install @acme/sdk"}
            </pre>
            <div className="rounded-md border border-border bg-card p-3 text-card-foreground">
              <div className="text-xs font-medium">Note</div>
              <p className="text-xs text-muted-foreground">Cards use the card colors.</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">Primary</span>
              <span className="text-xs text-primary underline underline-offset-2">A link</span>
            </div>
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Fonts other than Inter and JetBrains Mono appear on the live site only.</p>
    </div>
  )
}
