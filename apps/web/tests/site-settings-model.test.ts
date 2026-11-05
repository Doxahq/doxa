import { describe, expect, test } from "vitest"
import {
  FREE_PLAN_ENTITLEMENTS,
  resolveSiteConfig,
  toEditableSiteConfig,
  type EditableSiteConfig,
  type ValidationIssue,
} from "@doxahq/site-config"

import { contrastRatio } from "~/lib/dashboard/color-contrast"
import {
  applyThemeFile,
  createThemeFile,
  defaultSiteSettings,
  moveItem,
  removeItem,
  replaceItem,
} from "~/lib/dashboard/site-settings-edits"
import {
  activeServerIssues,
  countIssuesByTab,
  describePointer,
  issuesWithin,
  mergeIssues,
  recordServerIssues,
  tabForIssue,
} from "~/lib/dashboard/site-settings-issues"
import {
  formatSettingsJson,
  parseSettingsJson,
  validateSiteSettings,
} from "~/lib/dashboard/site-settings-validation"
import { sameSiteConfig } from "~/lib/dashboard/use-site-settings"

const context = { pageHrefs: ["/", "/quickstart"], entitlements: FREE_PLAN_ENTITLEMENTS }

function editable(input: Parameters<typeof resolveSiteConfig>[0] = {}): EditableSiteConfig {
  return toEditableSiteConfig(resolveSiteConfig({ name: "Acme", ...input }))
}

function issue(path: string, code: ValidationIssue["code"], severity: ValidationIssue["severity"] = "error"): ValidationIssue {
  return { path, code, severity, message: code }
}

describe("contrast", () => {
  test.each([
    ["#000", "#fff", 21],
    ["#ffffff", "#ffffff", 1],
    ["rgb(0 0 0)", "rgb(255, 255, 255)", 21],
    ["hsl(0 0% 0%)", "hsl(0, 0%, 100%)", 21],
    ["oklch(0 0 0)", "oklch(1 0 0)", 21],
    ["oklab(0% 0 0)", "oklab(100% 0 0)", 21],
  ])("%s on %s", (first, second, expected) => {
    expect(contrastRatio(first, second)).toBeCloseTo(expected, 1)
  })

  test("returns null for a value it cannot read", () => {
    expect(contrastRatio("red", "#fff")).toBeNull()
  })
})

describe("client validation", () => {
  test("a valid default config has no issues", () => {
    expect(validateSiteSettings(editable(), context)).toEqual([])
  })

  test("a plan without cloud search cannot choose it", () => {
    const config = editable()
    const choosing = { ...config, features: { ...config.features, searchProvider: "typesense" as const } }
    expect(validateSiteSettings(choosing, context)).toContainEqual(
      expect.objectContaining({ code: "entitlement_required" }),
    )
    expect(
      validateSiteSettings(choosing, {
        ...context,
        searchPolicy: { allowedProviders: ["typesense", "minisearch"] },
      }).filter((issue) => issue.code === "entitlement_required"),
    ).toEqual([])
  })

  test("a site that lost its plan can still save with its stored choice", () => {
    const config = editable()
    const stored = { ...config, features: { ...config.features, searchProvider: "typesense" as const } }
    expect(
      validateSiteSettings(stored, { ...context, savedSearchProvider: "typesense" }).filter(
        (issue) => issue.code === "entitlement_required",
      ),
    ).toEqual([])
  })

  test("shared rules report the field pointer and code", () => {
    const config = editable()
    const issues = validateSiteSettings(
      { ...config, navbar: { ...config.navbar, links: [{ label: "Blog", href: "javascript:alert(1)", newTab: false }] } },
      context,
    )
    expect(issues.map(({ path, code }) => ({ path, code }))).toContainEqual({
      path: "/navbar/links/0/href",
      code: expect.stringMatching(/invalid_href|unsafe_href_protocol/),
    })
  })

  test("hiding Powered by Doxa without the entitlement is an error", () => {
    const config = editable()
    const issues = validateSiteSettings(
      { ...config, branding: { ...config.branding, poweredBy: false } },
      context,
    )
    expect(issues).toContainEqual(expect.objectContaining({ path: "/branding/poweredBy", code: "entitlement_required" }))
    expect(
      validateSiteSettings(
        { ...config, branding: { ...config.branding, poweredBy: false } },
        { ...context, entitlements: { ...FREE_PLAN_ENTITLEMENTS, removePoweredBy: true } },
      ),
    ).toEqual([])
  })

  test("an internal link to a missing page is a warning", () => {
    const config = editable({ navbar: { cta: { label: "Start", href: "/missing" } } })
    expect(validateSiteSettings(config, context)).toEqual([
      expect.objectContaining({ path: "/navbar/cta/href", code: "link_target_not_found", severity: "warning" }),
    ])
  })

  test("low contrast warns only for a pair the user changed", () => {
    expect(validateSiteSettings(editable({ theme: { preset: "brutalist" } }), context)).toEqual([])
    const issues = validateSiteSettings(
      editable({ theme: { tokens: { light: { foreground: "#fefefe" } } } }),
      context,
    )
    expect(issues).toEqual([
      expect.objectContaining({ path: "/theme/tokens/light/foreground", code: "low_contrast", severity: "warning" }),
    ])
  })
})

describe("JSON tab parsing", () => {
  test("round-trips the formatted config", () => {
    const config = editable({ navbar: { links: [{ label: "Blog", href: "https://acme.dev/blog" }] } })
    expect(parseSettingsJson(formatSettingsJson(config))).toEqual({ ok: true, config })
  })

  test.each([
    ["{", "invalid_json"],
    ['{"name":"Acme","nope":1}', "unknown_key"],
    [`{"name":"${"x".repeat(70 * 1024)}"}`, "config_too_large"],
  ])("reports %# as %s", (text, code) => {
    const result = parseSettingsJson(text)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain(code)
  })
})

describe("issue store", () => {
  test("maps issues to the tab that owns the field", () => {
    expect(tabForIssue(issue("/name", "too_long"))).toBe("branding")
    expect(tabForIssue(issue("/branding/ogImage", "asset_not_found"))).toBe("seo")
    expect(tabForIssue(issue("/footer/groups/0/links/1/href", "invalid_href"))).toBe("footer")
    expect(tabForIssue(issue("/features/loadFromGithub", "invalid_type"))).toBe("json")
    expect(tabForIssue(issue("/navbar/nope", "unknown_key"))).toBe("json")
    expect(tabForIssue(issue("", "invalid_json"))).toBe("json")
  })

  test("merges client and server issues once, errors first", () => {
    const merged = mergeIssues(
      [issue("/a", "too_long", "warning"), issue("/b", "invalid_href")],
      [issue("/b", "invalid_href"), issue("/c", "asset_not_found")],
    )
    expect(merged.map(({ path, source, severity }) => `${path}:${source}:${severity}`)).toEqual([
      "/b:client:error",
      "/c:server:error",
      "/a:client:warning",
    ])
  })

  test("counts errors and warnings per tab", () => {
    const counts = countIssuesByTab(
      mergeIssues([issue("/navbar/github", "invalid_href"), issue("/navbar/cta/href", "link_target_not_found", "warning")], []),
    )
    expect(counts.navbar).toEqual({ errors: 1, warnings: 1 })
    expect(counts.theme).toEqual({ errors: 0, warnings: 0 })
  })

  test("a server issue clears when the value at its path changes", () => {
    const config = editable()
    const records = recordServerIssues([issue("/branding/logo/light", "asset_not_found")], {
      ...config,
      branding: { ...config.branding, logo: { ...config.branding.logo, light: `asset:${"a".repeat(64)}` } },
    })
    const unchanged = {
      ...config,
      name: "Renamed",
      branding: { ...config.branding, logo: { ...config.branding.logo, light: `asset:${"a".repeat(64)}` } },
    }
    expect(activeServerIssues(records, unchanged)).toHaveLength(1)
    expect(activeServerIssues(records, config)).toHaveLength(0)
  })

  test("describes pointers for the summary", () => {
    expect(describePointer("/navbar/links/2/href")).toBe("Navbar · Links 3 · Link")
    expect(describePointer("/theme/tokens/dark/codeBg")).toBe("Theme · Colors · Dark · codeBg")
    expect(describePointer("")).toBe("Settings")
  })

  test("finds issues inside a list", () => {
    const issues = mergeIssues([issue("/navbar/links/0/href", "invalid_href"), issue("/navbar/linksx", "unknown_key")], [])
    expect(issuesWithin(issues, "/navbar/links")).toHaveLength(1)
  })
})

describe("edit helpers", () => {
  test("list helpers never change the input", () => {
    const items = Object.freeze(["a", "b", "c"])
    expect(moveItem(items, 0, 2)).toEqual(["b", "c", "a"])
    expect(moveItem(items, 0, 9)).toEqual(["a", "b", "c"])
    expect(removeItem(items, 1)).toEqual(["a", "c"])
    expect(replaceItem(items, 1, "x")).toEqual(["a", "x", "c"])
  })

  test("a theme file replaces overrides and keeps the preset", () => {
    const theme = editable({ theme: { preset: "brutalist", tokens: { light: { card: "#111" } } } }).theme
    const next = applyThemeFile(theme, {
      name: "Custom",
      colorMode: "light-dark",
      fonts: { body: "Sora" },
      tokens: { light: { background: "#fafafa" }, dark: {} },
    })
    expect(next).toMatchObject({
      preset: "brutalist",
      colorMode: "light-dark",
      fonts: { body: "Sora" },
      tokens: { light: { background: "#fafafa" }, dark: {} },
    })
  })

  test("an exported theme file resolves to the same tokens", () => {
    const resolved = resolveSiteConfig({ theme: { preset: "brutalist", primary: "#3b82f6" } })
    const file = createThemeFile(resolved.theme, "Acme theme")
    const base = editable({ theme: { preset: "default" } })
    const applied = resolveSiteConfig({ ...base, theme: applyThemeFile(base.theme, file) })
    expect(applied.theme.tokens).toEqual(resolved.theme.tokens)
  })
})

describe("default settings", () => {
  test("use every default and the project name as the site name", () => {
    expect(defaultSiteSettings("Acme")).toEqual(editable())
  })

  test("fall back to a generic name when the project name is blank", () => {
    expect(defaultSiteSettings(" \n ").name).toBe("Documentation")
  })

  test("are valid, so the restore can save them", () => {
    expect(validateSiteSettings(defaultSiteSettings("Acme"), context)).toEqual([])
  })

  test("read back equal after the server stores the resolved config", () => {
    const defaults = defaultSiteSettings("Acme")
    expect(sameSiteConfig(toEditableSiteConfig(resolveSiteConfig(defaults)), defaults)).toBe(true)
  })

  test("differ from a customized config", () => {
    expect(sameSiteConfig(editable({ theme: { preset: "brutalist" } }), defaultSiteSettings("Acme"))).toBe(false)
  })
})
