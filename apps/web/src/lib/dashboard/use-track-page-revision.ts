import { useEffect } from "react"

import type { DraftBufferSource } from "~/lib/dashboard/use-draft-buffer"

/** For each page buffer, the branch revision that its text came from. */
export type PageRevisions = Map<string, number>

export type LoadedPageSource = DraftBufferSource<string> & { revision: number }

interface PageBufferState {
  key: string | null
  saved: string | null
  isDirty: boolean
  replaceClean: (key: string, value: string) => void
}

/**
 * Keeps `revisions` true to the text in the buffer, so that a save proves
 * which text it replaces. Each edit of any page moves the branch revision, so
 * every page load is compared with the buffer:
 *
 * - The same text: this page did not change, so the buffer takes the revision.
 * - New text and no unsaved edits: the buffer takes the text and the revision.
 * - New text and unsaved edits: the revision stays, so the server refuses the
 *   save and it cannot overwrite the newer text.
 */
export function useTrackPageRevision({
  enabled,
  revisions,
  loaded,
  buffer,
}: {
  enabled: boolean
  revisions: PageRevisions
  loaded: LoadedPageSource | null
  buffer: PageBufferState
}): void {
  const { key: bufferKey, saved, isDirty, replaceClean } = buffer

  useEffect(() => {
    if (!enabled || loaded === null) return
    const { key, value, revision } = loaded
    const known = revisions.get(key)
    // The buffer takes this page now, so the text and the revision are one read.
    if (known === undefined || bufferKey !== key) {
      revisions.set(key, revision)
      return
    }
    if (revision < known) return // A slow answer from before the last save.
    if (value !== saved) {
      if (isDirty) return
      replaceClean(key, value)
    }
    revisions.set(key, revision)
  }, [bufferKey, enabled, isDirty, loaded, replaceClean, revisions, saved])
}
