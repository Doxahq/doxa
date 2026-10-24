import { useEffect, useSyncExternalStore } from "react"
import { DOCS_ICON_NAMES, type DocsIconName } from "@doxahq/docs-prose"
import {
  CORE_ICON_CURRENT_NAMES,
  coreIconNode,
  docsIconKey,
  type DocsIconNode,
  type LucideIconData,
} from "@doxahq/docs-prose/icons"
import { FileText, Folder, FolderOpen, type LucideIcon } from "lucide-react"

/**
 * Docs icons in the dashboard: every Lucide icon, as the published site draws
 * it (`@doxahq/docs-prose/icons`).
 *
 * The suggested icons are in the main bundle, so most pages draw their icons
 * on the first frame. The full set (about 90 KB gzipped) loads lazily, the
 * first time a page shows an icon outside it or the icon picker opens. The
 * picker's search words load only when the picker opens.
 */

/** A store for one lazily loaded module: load once, share the result, retry after a failure. */
function lazyModule<T>(load: () => Promise<T>) {
  let value: T | null = null
  let pending: Promise<T> | null = null
  const listeners = new Set<() => void>()

  return {
    load(): Promise<T> {
      pending ??= load().then(
        (loaded) => {
          value = loaded
          for (const listener of listeners) listener()
          return loaded
        },
        (error: unknown) => {
          pending = null
          throw error
        },
      )
      return pending
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get: () => value,
  }
}

const lucideIcons = lazyModule<LucideIconData>(() =>
  import("@doxahq/docs-prose/icons/lucide").then((module) => module.LUCIDE_ICON_DATA),
)

const lucideTags = lazyModule<Readonly<Record<string, readonly string[]>>>(() =>
  import("@doxahq/docs-prose/icons/lucide-tags").then((module) => module.LUCIDE_ICON_TAGS),
)

/** Loads the full icon set, and the search words when asked. */
export async function loadDocsIcons(options: { tags?: boolean } = {}): Promise<void> {
  await Promise.all([lucideIcons.load(), options.tags ? lucideTags.load() : null])
}

/** Starts loading the full icon set. Call it when an icon picker may open soon. A failure retries on the next call. */
export function preloadDocsIcons(options: { tags?: boolean } = {}): void {
  loadDocsIcons(options).catch(() => {})
}

/** The full icon set, or null until it loads. */
export function useLucideIcons(): LucideIconData | null {
  return useSyncExternalStore(lucideIcons.subscribe, lucideIcons.get, () => null)
}

/** The search words of every icon, or null until they load. */
export function useLucideTags(): Readonly<Record<string, readonly string[]>> | null {
  return useSyncExternalStore(lucideTags.subscribe, lucideTags.get, () => null)
}

/**
 * The current Lucide name for a stored icon name, following renames
 * (`circleHelp` is `circleQuestionMark`). Null when the name is no icon, or
 * when it needs the full set and that has not loaded yet.
 */
export function currentIconName(name: string | null | undefined, icons: LucideIconData | null): string | null {
  const key = docsIconKey(name)
  if (!key) return null
  const core = CORE_ICON_CURRENT_NAMES[key]
  if (core) return core
  if (!icons) return null
  if (icons.icons[key]) return key
  const renamed = icons.aliases[key]
  return renamed && icons.icons[renamed] ? renamed : null
}

/**
 * The glyph for an icon name: the node, `undefined` while the full set loads,
 * or null when the name is no icon.
 */
export function useDocsIconNode(name: string | null | undefined): DocsIconNode | null | undefined {
  const key = docsIconKey(name)
  const core = coreIconNode(key)
  const icons = useLucideIcons()
  const needsFullSet = key !== null && core === null && icons === null

  useEffect(() => {
    if (needsFullSet) lucideIcons.load().catch(() => {})
  }, [needsFullSet])

  if (!key) return null
  if (core) return core
  if (!icons) return undefined
  const current = currentIconName(key, icons)
  return current ? icons.icons[current]! : null
}

/** Drawn when the navigation carries no icon for a page. */
export const DEFAULT_DOCS_PAGE_ICON: LucideIcon = FileText

/**
 * Section glyph for the content editor tree.
 *
 * Generated sites do not write section icons, so the glyph carries the open
 * state instead of an identity. An open folder means expanded, and a closed
 * folder means collapsed. Page icons stay the only variable glyphs in the list.
 */
export function resolveDocsSectionIcon(isExpanded: boolean): LucideIcon {
  return isExpanded ? FolderOpen : Folder
}

/**
 * Extra words that find a suggested icon in the icon picker search, beside
 * its name and Lucide's own search words. Checked against the shared
 * vocabulary.
 */
const SUGGESTED_ICON_KEYWORDS = {
  alignJustify: ["text", "paragraph", "lines"],
  arrowUpRight: ["external", "link", "open"],
  beaker: ["experiment", "test", "lab"],
  book: ["docs", "guide", "manual"],
  bookOpen: ["docs", "read", "guide", "tutorial"],
  box: ["package", "container", "module"],
  circleHelp: ["help", "question", "faq", "support"],
  code: ["developer", "snippet", "programming"],
  cog: ["gear", "settings", "configuration"],
  compass: ["explore", "navigate", "overview", "start"],
  database: ["data", "storage", "sql"],
  file: ["page", "document"],
  flag: ["feature", "milestone", "report"],
  folder: ["directory", "group"],
  globe: ["web", "world", "internet", "network"],
  house: ["home", "start", "welcome"],
  key: ["auth", "authentication", "security", "token", "password"],
  layers: ["stack", "architecture", "levels"],
  list: ["items", "reference", "index"],
  package: ["install", "dependency", "library", "npm"],
  play: ["start", "run", "quickstart", "demo"],
  plug: ["integration", "plugin", "connect"],
  rocket: ["launch", "deploy", "quickstart", "start"],
  search: ["find", "lookup"],
  server: ["backend", "host", "api", "deploy"],
  settings: ["gear", "configuration", "options", "preferences"],
  shield: ["security", "protection", "privacy"],
  terminal: ["cli", "command", "shell", "console"],
  wrench: ["tool", "fix", "maintenance", "setup"],
  zap: ["lightning", "fast", "performance", "events"],
} satisfies Record<DocsIconName, readonly string[]>

/** The extra search words, by current Lucide name. */
export const SUGGESTED_ICON_SEARCH_WORDS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  DOCS_ICON_NAMES.map((name) => [CORE_ICON_CURRENT_NAMES[name] ?? name, SUGGESTED_ICON_KEYWORDS[name]]),
)
