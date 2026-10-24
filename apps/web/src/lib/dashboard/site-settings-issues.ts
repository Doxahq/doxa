import { fromJsonPointer, type ValidationIssue } from "@doxahq/site-config"

export const SITE_SETTINGS_TABS = [
  "branding",
  "theme",
  "navbar",
  "footer",
  "seo",
  "features",
  "json",
] as const

export type SiteSettingsTab = (typeof SITE_SETTINGS_TABS)[number]

export const SITE_SETTINGS_TAB_LABELS = {
  branding: "Branding",
  theme: "Theme",
  navbar: "Navbar",
  footer: "Footer",
  seo: "SEO",
  features: "Features",
  json: "JSON",
} as const satisfies Record<SiteSettingsTab, string>

export type IssueSource = "client" | "server"

export interface SettingsIssue extends ValidationIssue {
  source: IssueSource
}

/**
 * Feature flags that change nothing on a published site. The form hides them,
 * and their issues can only be corrected in the JSON tab.
 */
const JSON_ONLY_POINTERS = new Set([
  "/features/branding",
  "/features/loadFromGithub",
  "/features/AgressiveNavPrefetch",
])

/** The tab whose form owns a setting. Anything without a form field is JSON. */
export function tabForIssue(issue: Pick<ValidationIssue, "path" | "code">): SiteSettingsTab {
  if (issue.code === "unknown_key" || issue.code === "invalid_json") return "json"
  return tabForPointer(issue.path)
}

export function tabForPointer(pointer: string): SiteSettingsTab {
  if (JSON_ONLY_POINTERS.has(pointer)) return "json"
  const [head, second] = fromJsonPointer(pointer)
  switch (head) {
    case "name":
    case "description":
      return "branding"
    case "branding":
      return second === "ogImage" ? "seo" : "branding"
    // Layout is drawn on the Appearance page with the theme.
    case "layout":
      return "theme"
    case "theme":
    case "navbar":
    case "footer":
    case "seo":
    case "features":
      return head
    default:
      return "json"
  }
}

/** Issues for one field, errors first. */
export function issuesAt(
  issues: readonly SettingsIssue[],
  pointer: string,
): SettingsIssue[] {
  return sortBySeverity(issues.filter((issue) => issue.path === pointer))
}

/** Issues for a field and everything inside it, for list and group summaries. */
export function issuesWithin(
  issues: readonly SettingsIssue[],
  pointer: string,
): SettingsIssue[] {
  return issues.filter(
    (issue) => issue.path === pointer || issue.path.startsWith(`${pointer}/`),
  )
}

export interface TabIssueCount {
  errors: number
  warnings: number
}

export function countIssuesByTab(
  issues: readonly SettingsIssue[],
): Record<SiteSettingsTab, TabIssueCount> {
  const empty = (): TabIssueCount => ({ errors: 0, warnings: 0 })
  const counts: Record<SiteSettingsTab, TabIssueCount> = {
    branding: empty(),
    theme: empty(),
    navbar: empty(),
    footer: empty(),
    seo: empty(),
    features: empty(),
    json: empty(),
  }
  for (const issue of issues) {
    const count = counts[tabForIssue(issue)]
    if (issue.severity === "error") count.errors += 1
    else count.warnings += 1
  }
  return counts
}

/**
 * Client and server issues in one list.
 *
 * The server repeats every shared rule, so an issue with the same path and
 * code from both sides is shown once, as the client copy.
 */
export function mergeIssues(
  client: readonly ValidationIssue[],
  server: readonly ValidationIssue[],
): SettingsIssue[] {
  const seen = new Set(client.map(issueKey))
  return sortBySeverity([
    ...client.map((issue): SettingsIssue => ({ ...issue, source: "client" })),
    ...server
      .filter((issue) => !seen.has(issueKey(issue)))
      .map((issue): SettingsIssue => ({ ...issue, source: "server" })),
  ])
}

/** A server issue with the value it was reported for. */
export interface ServerIssueRecord {
  issue: ValidationIssue
  /** JSON of the value at the issue path when the server rejected it. */
  valueSnapshot: string
}

export function recordServerIssues(
  issues: readonly ValidationIssue[],
  config: unknown,
): ServerIssueRecord[] {
  return issues.map((issue) => ({ issue, valueSnapshot: snapshotAt(config, issue.path) }))
}

/** Keeps a server issue only while the value at its path is unchanged. */
export function activeServerIssues(
  records: readonly ServerIssueRecord[],
  config: unknown,
): ValidationIssue[] {
  return records
    .filter((record) => snapshotAt(config, record.issue.path) === record.valueSnapshot)
    .map((record) => record.issue)
}

export function hasErrors(issues: readonly Pick<ValidationIssue, "severity">[]): boolean {
  return issues.some((issue) => issue.severity === "error")
}

const SEGMENT_LABELS: Readonly<Record<string, string>> = {
  name: "Site name",
  description: "Description",
  branding: "Branding",
  logo: "Logo",
  light: "Light",
  dark: "Dark",
  href: "Link",
  favicon: "Favicon",
  ogImage: "Social image",
  poweredBy: "Powered by Doxa",
  theme: "Theme",
  preset: "Preset",
  defaultMode: "Default mode",
  colorMode: "Color mode",
  primary: "Primary color",
  radius: "Corner radius",
  fonts: "Fonts",
  body: "Body font",
  code: "Code font",
  tokens: "Colors",
  navbar: "Navbar",
  cta: "Button",
  links: "Links",
  github: "GitHub",
  label: "Label",
  newTab: "New tab",
  variant: "Style",
  footer: "Footer",
  groups: "Link groups",
  title: "Title",
  socials: "Social links",
  x: "X",
  linkedin: "LinkedIn",
  discord: "Discord",
  youtube: "YouTube",
  seo: "SEO",
  keywords: "Keywords",
  twitterHandle: "X handle",
  features: "Features",
}

/** A readable location for the issue summary, for example "Navbar · Links 3 · Link". */
export function describePointer(pointer: string): string {
  const segments = fromJsonPointer(pointer)
  if (segments.length === 0) return "Settings"
  const parts: string[] = []
  for (const segment of segments) {
    if (/^\d+$/.test(segment)) {
      const previous = parts.pop() ?? "Item"
      parts.push(`${previous} ${Number(segment) + 1}`)
    } else {
      parts.push(SEGMENT_LABELS[segment] ?? segment)
    }
  }
  return parts.join(" · ")
}

/** The DOM id of the control that edits a setting. */
export function fieldIdForPointer(pointer: string): string {
  return `site-setting:${pointer}`
}

function issueKey(issue: Pick<ValidationIssue, "path" | "code">): string {
  return `${issue.path}\u0000${issue.code}`
}

function sortBySeverity<TIssue extends Pick<ValidationIssue, "severity">>(
  issues: TIssue[],
): TIssue[] {
  return issues.sort(
    (left, right) => Number(left.severity === "warning") - Number(right.severity === "warning"),
  )
}

function snapshotAt(config: unknown, pointer: string): string {
  let current = config
  for (const segment of fromJsonPointer(pointer)) {
    if (Array.isArray(current)) current = current[Number(segment)]
    else if (typeof current === "object" && current !== null && Object.hasOwn(current, segment)) {
      current = Object.getOwnPropertyDescriptor(current, segment)?.value
    } else return "undefined"
  }
  return JSON.stringify(current) ?? "undefined"
}
