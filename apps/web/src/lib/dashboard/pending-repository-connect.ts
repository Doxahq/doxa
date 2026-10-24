const STORAGE_KEY = "doxa:pending-repository-connect"

/**
 * GitHub returns to `/dashboard?github=connected` after the app install. When
 * the install started from a project without a repository, this remembers the
 * project, so the dashboard returns there to finish the connection.
 */
export function writePendingRepositoryConnect(projectId: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, projectId)
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

export function readPendingRepositoryConnect(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function clearPendingRepositoryConnect(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}
