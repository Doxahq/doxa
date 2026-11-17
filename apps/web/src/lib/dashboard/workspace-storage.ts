import { readLastProjectId } from "~/lib/dashboard/last-project"
import type { WorkspaceId } from "~/lib/dashboard/workspace-model"

/**
 * What the browser keeps about workspaces, like `doxa:last-project`: the
 * workspace the person works in, the project they opened last in each one,
 * and whether they closed the tip that shows where the workspace menu is.
 * Storage can be unavailable (private windows, blocked site data): reads
 * then answer "nothing stored" and writes do nothing.
 */
const WORKSPACE_KEY = "doxa:workspace"
const LAST_PROJECTS_KEY = "doxa:last-project-by-workspace"
const MENU_TIP_KEY = "doxa:workspace-menu-tip-seen"

const listeners = new Set<() => void>()

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
  for (const listener of listeners) listener()
}

/** Calls `listener` after a write here or in another tab. */
export function subscribeWorkspaceStorage(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === WORKSPACE_KEY || event.key === MENU_TIP_KEY) listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

export function readStoredWorkspaceId(): WorkspaceId | null {
  return read(WORKSPACE_KEY)
}

export function writeStoredWorkspaceId(workspaceId: WorkspaceId): void {
  if (read(WORKSPACE_KEY) !== workspaceId) write(WORKSPACE_KEY, workspaceId)
}

function readLastProjects(): Record<WorkspaceId, string> {
  const raw = read(LAST_PROJECTS_KEY)
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return isStringRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  )
}

/**
 * The project the person opened last in the workspace, so a switch can land
 * there. Before one is recorded, the project opened last anywhere: the
 * caller keeps it only when it is in the workspace.
 */
export function readLastProjectIdIn(workspaceId: WorkspaceId): string | null {
  return readLastProjects()[workspaceId] ?? readLastProjectId()
}

export function writeLastProjectIdIn(workspaceId: WorkspaceId, projectId: string): void {
  const lastProjects = readLastProjects()
  if (lastProjects[workspaceId] === projectId) return
  try {
    localStorage.setItem(LAST_PROJECTS_KEY, JSON.stringify({ ...lastProjects, [workspaceId]: projectId }))
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

export function readWorkspaceMenuTipSeen(): boolean {
  return read(MENU_TIP_KEY) === "1"
}

export function markWorkspaceMenuTipSeen(): void {
  write(MENU_TIP_KEY, "1")
}
