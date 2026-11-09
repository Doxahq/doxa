import { useCallback, useMemo, useSyncExternalStore } from "react"
import { z } from "zod"

import { SETUP_STEP_IDS, type SetupStepId } from "~/lib/dashboard/project-setup-model"

const preferencesSchema = z.object({
  skipped: z.array(z.enum(SETUP_STEP_IDS)),
  hidden: z.boolean(),
})

type SetupPreferences = z.infer<typeof preferencesSchema>

const NO_PREFERENCES: SetupPreferences = { skipped: [], hidden: false }

const listeners = new Set<() => void>()

function storageKey(projectId: string): string {
  return `doxa:project-setup:${projectId}`
}

function readRaw(projectId: string): string | null {
  try {
    return localStorage.getItem(storageKey(projectId))
  } catch {
    return null
  }
}

function parsePreferences(raw: string | null): SetupPreferences {
  if (!raw) return NO_PREFERENCES
  try {
    const value: unknown = JSON.parse(raw)
    const parsed = preferencesSchema.safeParse(value)
    return parsed.success ? parsed.data : NO_PREFERENCES
  } catch {
    return NO_PREFERENCES
  }
}

function writePreferences(projectId: string, preferences: SetupPreferences): void {
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(preferences))
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
  listeners.forEach((notify) => notify())
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify)
  window.addEventListener("storage", notify)
  return () => {
    listeners.delete(notify)
    window.removeEventListener("storage", notify)
  }
}

export interface ProjectSetupPreferences {
  skipped: ReadonlySet<SetupStepId>
  hidden: boolean
  skip: (step: SetupStepId) => void
  hide: () => void
}

/** The optional steps that a person skipped, per browser and project. */
export function useProjectSetupPreferences(projectId: string): ProjectSetupPreferences {
  const raw = useSyncExternalStore(
    subscribe,
    () => readRaw(projectId),
    () => null,
  )
  const preferences = useMemo(() => parsePreferences(raw), [raw])
  const skipped = useMemo(() => new Set(preferences.skipped), [preferences])

  const skip = useCallback(
    (step: SetupStepId) => {
      const current = parsePreferences(readRaw(projectId))
      writePreferences(projectId, { ...current, skipped: [...new Set([...current.skipped, step])] })
    },
    [projectId],
  )
  const hide = useCallback(() => {
    writePreferences(projectId, { ...parsePreferences(readRaw(projectId)), hidden: true })
  }, [projectId])

  return { skipped, hidden: preferences.hidden, skip, hide }
}
