const STORAGE_KEY = "doxa:last-project"

/** The project the user opened last, so `/dashboard` can land in it. */
export function readLastProjectId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function writeLastProjectId(projectId: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, projectId)
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

/** Picks the landing project: the last opened one if it still exists, else the first. */
export function resolveLandingProjectId(
  projects: readonly { id: string }[],
  lastProjectId: string | null,
): string | null {
  if (lastProjectId && projects.some(({ id }) => id === lastProjectId)) return lastProjectId
  return projects[0]?.id ?? null
}
