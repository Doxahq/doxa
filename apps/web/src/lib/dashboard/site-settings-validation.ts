import {
  createValidationIssue,
  parseSiteConfigStrict,
  resolveSiteConfig,
  SITE_CONFIG_LIMITS,
  toEditableSiteConfig,
  toJsonPointer,
  validateSiteConfigLinks,
  type EditableSiteConfig,
  type ProjectEntitlements,
  type ResolvedSiteConfig,
  type ValidationIssue,
} from "@doxahq/site-config"

import { contrastRatio } from "~/lib/dashboard/color-contrast"

/** WCAG AA for body text. */
const MINIMUM_TEXT_CONTRAST = 4.5

/** Surface and text token pairs that carry readable text on the docs site. */
const TEXT_TOKEN_PAIRS = [
  ["background", "foreground"],
  ["card", "cardForeground"],
  ["popover", "popoverForeground"],
  ["primary", "primaryForeground"],
  ["secondary", "secondaryForeground"],
  ["accent", "accentForeground"],
  ["sidebar", "sidebarForeground"],
  ["codeBg", "codeFg"],
] as const

export interface SiteSettingsContext {
  /** Absent means the free plan: browser search only. */
  searchPolicy?: { allowedProviders: readonly string[] }
  /** A site that lost its plan may keep its stored choice, as the API allows. */
  savedSearchProvider?: string | undefined
  pageHrefs: readonly string[]
  entitlements: ProjectEntitlements
}

/**
 * Every issue the dashboard can find without the server.
 *
 * The shared rules come from `@doxahq/site-config`, the same functions the API
 * runs. The contrast check is a client-only warning and never blocks a save.
 */
export function validateSiteSettings(
  config: EditableSiteConfig,
  context: SiteSettingsContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!config.branding.poweredBy && !context.entitlements.removePoweredBy) {
    issues.push(createValidationIssue("entitlement_required", "/branding/poweredBy"))
  }
  const searchChoice = config.features.searchProvider
  if (
    searchChoice &&
    searchChoice !== context.savedSearchProvider &&
    !(context.searchPolicy?.allowedProviders ?? ["minisearch"]).includes(searchChoice)
  ) {
    issues.push(createValidationIssue("entitlement_required", "/features/searchProvider"))
  }

  const strict = parseSiteConfigStrict(config)
  if (!strict.ok) return [...issues, ...strict.issues]

  const resolved = resolveSiteConfig(strict.config)
  return [
    ...issues,
    ...validateSiteConfigLinks(resolved, context.pageHrefs),
    ...contrastWarnings(config, resolved),
  ]
}

function contrastWarnings(
  config: EditableSiteConfig,
  resolved: ResolvedSiteConfig,
): ValidationIssue[] {
  const modes =
    resolved.theme.colorMode === "dark-only" ? (["light"] as const) : (["light", "dark"] as const)
  const warnings: ValidationIssue[] = []

  for (const mode of modes) {
    const tokens = resolved.theme.tokens[mode]
    const overrides = config.theme.tokens[mode]
    const changedBy = (token: string): string | null => {
      if (overrides[token] !== undefined) return toJsonPointer(["theme", "tokens", mode, token])
      if (token === "primary" && config.theme.primary !== null) return "/theme/primary"
      return null
    }

    for (const [surface, text] of TEXT_TOKEN_PAIRS) {
      // A preset is reviewed by Doxa. Warn only when a person changed the pair.
      const pointer = changedBy(text) ?? changedBy(surface)
      if (!pointer) continue
      const ratio = contrastRatio(tokens[surface] ?? "", tokens[text] ?? "")
      if (ratio === null || ratio >= MINIMUM_TEXT_CONTRAST) continue
      warnings.push(
        createValidationIssue(
          "low_contrast",
          pointer,
          { ratio: Math.round(ratio * 100) / 100 },
          "warning",
        ),
      )
    }
  }
  return dedupeByPath(warnings)
}

export type SettingsJsonResult =
  | { ok: true; config: EditableSiteConfig }
  | { ok: false; issues: ValidationIssue[] }

/**
 * Reads the JSON tab text.
 *
 * The size check runs on the raw bytes before `JSON.parse`, like the API, so a
 * pasted multi-megabyte document is rejected without being parsed.
 */
export function parseSettingsJson(text: string): SettingsJsonResult {
  const bytes = new TextEncoder().encode(text).byteLength
  if (bytes > SITE_CONFIG_LIMITS.configBytes) {
    return {
      ok: false,
      issues: [
        createValidationIssue("config_too_large", "", { max: SITE_CONFIG_LIMITS.configBytes }),
      ],
    }
  }

  let input: unknown
  try {
    input = JSON.parse(text)
  } catch {
    return { ok: false, issues: [createValidationIssue("invalid_json")] }
  }

  const strict = parseSiteConfigStrict(input)
  if (!strict.ok) return { ok: false, issues: strict.issues }
  return { ok: true, config: toEditableSiteConfig(resolveSiteConfig(strict.config)) }
}

/** The JSON tab text for a config: two-space indent, schema key order. */
export function formatSettingsJson(config: EditableSiteConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

function dedupeByPath(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    if (seen.has(issue.path)) return false
    seen.add(issue.path)
    return true
  })
}
