/** Which dialog the new project page opens on arrival. */
export type NewProjectStart = "repository" | "template"

export interface NewProjectSearch {
  start?: NewProjectStart
}

/**
 * `?start=repository` opens the "Generate from a repository" dialog, for
 * example when GitHub returns after the app install. `?start=template` opens
 * the starter or empty docs dialog. Any other value opens no dialog.
 */
export function parseNewProjectSearch(search: Record<string, unknown>): NewProjectSearch {
  return search.start === "repository" || search.start === "template" ? { start: search.start } : {}
}
