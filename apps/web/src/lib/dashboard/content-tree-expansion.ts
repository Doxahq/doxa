import type { ContentTreeSection } from "~/lib/dashboard/content-navigation"

/**
 * The open sections and groups of the content sidebar, saved per project in
 * this browser, so a reload shows the tree as the person left it.
 *
 * Ids are section slugs and group ids (see `createTreeGroup`). A renamed group
 * gets a new id, so it starts closed again. Ids of rows that no longer exist
 * are dropped on the next save, which keeps the value small.
 */
const STORAGE_PREFIX = "doxa:content-tree:"
/** A safety cap. A real tree holds far fewer open rows. */
const MAX_SAVED_IDS = 500

function storageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`
}

/** The saved open rows, or null when this browser has none for the project. */
export function readExpandedContentRows(projectId: string): string[] | null {
  try {
    const stored = localStorage.getItem(storageKey(projectId))
    if (stored === null) return null
    const value: unknown = JSON.parse(stored)
    return Array.isArray(value) && value.every((id) => typeof id === "string") ? value : null
  } catch {
    return null
  }
}

/** Saves the open rows that exist in `tree`. */
export function writeExpandedContentRows(
  projectId: string,
  tree: readonly ContentTreeSection[],
  expandedIds: ReadonlySet<string>,
): void {
  const known = new Set(tree.flatMap((section) => [section.slug, ...section.groups.map((group) => group.id)]))
  const ids = [...expandedIds].filter((id) => known.has(id)).slice(0, MAX_SAVED_IDS)
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(ids))
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}
