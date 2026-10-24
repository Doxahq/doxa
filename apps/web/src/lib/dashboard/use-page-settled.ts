import { useEffect, useState } from "react"

import { whenPageSettles } from "~/lib/when-page-settles"

let hasSettled = false

/**
 * False until the page settles once (see `whenPageSettles`), then true for
 * the rest of the page load. Use it to hold back requests that the first
 * paint does not need, so they do not compete with the page the person opened.
 *
 * The server render and the first client render are always false, so they
 * stay identical. A component that mounts after the page settled starts true.
 */
export function usePageSettled(): boolean {
  const [settled, setSettled] = useState(() => hasSettled && typeof window !== "undefined")

  useEffect(() => {
    if (settled) return
    if (hasSettled) {
      setSettled(true)
      return
    }
    return whenPageSettles(() => {
      hasSettled = true
      setSettled(true)
    })
  }, [settled])

  return settled
}

/** Test helper: forgets that the page settled. */
export function resetPageSettledForTests(): void {
  hasSettled = false
}
