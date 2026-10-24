import type { PageLock, PageLockList, SetPageLockInput } from "@doxahq/contracts/generation-reviews"

import { apiFetch } from "~/lib/platform-api"

function locksPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/page-locks`
}

/** The pages that a person locked against generations. */
export async function listPageLocks(projectId: string): Promise<PageLock[]> {
  const response = await apiFetch<PageLockList>(locksPath(projectId))
  return response.pages
}

/** Locks or unlocks one page, and returns every lock of the site. */
export async function setPageLock(projectId: string, input: SetPageLockInput): Promise<PageLock[]> {
  const response = await apiFetch<PageLockList>(locksPath(projectId), { method: "PUT", json: input })
  return response.pages
}
