// @vitest-environment jsdom
import { describe, expect, test } from "vitest"
import type { DocsContentOverviewDto } from "@doxahq/contracts"
import { resolveSiteConfig } from "@doxahq/site-config"

import { act, render, renderHook } from "@testing-library/react"
import { createElement } from "react"

import { SiteCanvas } from "~/components/dashboard/content/site-canvas"
import { canvasPresetCss, hasLightMode, siteCanvasTheme, useCanvasMode } from "~/lib/dashboard/site-canvas"

type SiteConfigField = DocsContentOverviewDto["siteConfig"]

function siteConfig(published: object, working: object | null = null): SiteConfigField {
  return {
    published: resolveSiteConfig(published),
    working: working ? resolveSiteConfig(working) : null,
  } as SiteConfigField
}

describe("site canvas theme", () => {
  test("uses the working config, which holds unpublished settings changes", () => {
    const theme = siteCanvasTheme(siteConfig({ theme: { primary: "#111111" } }, { theme: { primary: "#222222" } }))
    expect(theme.tokens.light.primary).toBe("#222222")
  })

  test("uses the published config when the branch has no working config", () => {
    const theme = siteCanvasTheme(siteConfig({ theme: { primary: "#111111" } }))
    expect(theme.tokens.light.primary).toBe("#111111")
  })

  test("falls back to the default theme without a readable config", () => {
    expect(siteCanvasTheme(null)).toEqual(resolveSiteConfig({}).theme)
    const broken = { published: { theme: { preset: "missing" } }, working: null } as unknown as SiteConfigField
    expect(siteCanvasTheme(broken)).toEqual(resolveSiteConfig({}).theme)
  })

  test("keeps preset rules inside the canvas", () => {
    const brutalist = resolveSiteConfig({ theme: { preset: "brutalist" } }).theme
    const css = canvasPresetCss(brutalist)
    expect(css).toContain(".doxa-site-canvas ::selection {")
    for (const line of css.split("\n")) expect(line.startsWith(".doxa-site-canvas")).toBe(true)
    expect(hasLightMode(brutalist)).toBe(false)
    expect(canvasPresetCss(resolveSiteConfig({}).theme)).toBe("")
  })
})

describe("site canvas element", () => {
  test("takes the site's accent for the page, but keeps the dashboard focus ring", () => {
    const theme = resolveSiteConfig({ theme: { primary: "#ff0055" } }).theme
    const { container } = render(createElement(SiteCanvas, { theme, mode: "light", children: null }))
    const canvas = container.firstElementChild as HTMLElement
    expect(canvas.style.getPropertyValue("--primary")).toBe("#ff0055")
    expect(canvas.style.getPropertyValue("--ring")).toBe("var(--dashboard-primary)")
  })
})

describe("canvas color mode", () => {
  test("starts dark, whatever the site's default, and can switch to light", () => {
    const theme = resolveSiteConfig({ theme: { defaultMode: "light" } }).theme
    const hook = renderHook(() => useCanvasMode(theme))
    expect(hook.result.current[0]).toBe("dark")
    act(() => hook.result.current[1]("light"))
    expect(hook.result.current[0]).toBe("light")
  })

  test("stays dark for a dark-only site", () => {
    const theme = resolveSiteConfig({ theme: { preset: "brutalist" } }).theme
    const hook = renderHook(() => useCanvasMode(theme))
    act(() => hook.result.current[1]("light"))
    expect(hook.result.current[0]).toBe("dark")
  })
})
