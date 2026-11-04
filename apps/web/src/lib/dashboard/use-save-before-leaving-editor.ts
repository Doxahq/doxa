import { useBlocker } from "@tanstack/react-router"
import { toast } from "sonner"

/**
 * Leaving the editor cancels its autosave timer, so a route change out of the
 * editor saves the latest edit first. If the save fails, the person stays in
 * the editor with the edit. A closing tab cannot wait for a save, so the
 * browser warns while an edit is unsaved.
 */
export function useSaveBeforeLeavingEditor({
  projectId,
  isDirty,
  saveBuffer,
}: {
  projectId: string
  isDirty: boolean
  saveBuffer: () => Promise<boolean>
}) {
  const base = `/dashboard/projects/${projectId}/content`
  useBlocker({
    shouldBlockFn: async ({ next }) => {
      if (next.pathname === base || next.pathname.startsWith(`${base}/`)) return false
      // A save needs a session, so it must not hold a signed-out person here.
      if (next.pathname === "/login") return false
      if (await saveBuffer()) return false
      toast.error("Could not save this page, so you are still in the editor. Try again.")
      return true
    },
    enableBeforeUnload: () => isDirty,
  })
}
