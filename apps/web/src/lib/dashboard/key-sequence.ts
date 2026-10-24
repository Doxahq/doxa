import { useEffect, useRef } from "react"

import { hasOpenOverlay, isEditableTarget } from "~/lib/dashboard/shell-context"

/** A two-key shortcut typed one key after the other, such as G then O. Keys are lower case. */
export type KeySequence = readonly [string, string]

/** How long the first key of a sequence waits for the second one. */
export const SEQUENCE_TIMEOUT_MS = 1000

export interface SequenceStep {
  /** The first key, while it waits for the second one. */
  pending: string | null
  match: KeySequence | null
}

/**
 * Feeds one key press into the sequence state. A second key that completes a
 * sequence returns it. Any other key starts over, and it can itself start a
 * new sequence.
 */
export function stepKeySequence(
  pending: string | null,
  key: string,
  sequences: readonly KeySequence[],
): SequenceStep {
  const pressed = key.toLowerCase()
  if (pending !== null) {
    const match = sequences.find(([first, second]) => first === pending && second === pressed)
    if (match) return { pending: null, match }
  }
  const startsSequence = sequences.some(([first]) => first === pressed)
  return { pending: startsSequence ? pressed : null, match: null }
}

export interface SequenceBinding {
  sequence: KeySequence
  run: () => void
}

/**
 * Listens for the bound sequences on the whole window. Keys typed into a text
 * field or an editor, keys with a modifier, and keys pressed while a dialog
 * or menu is open do not count.
 */
export function useKeySequences(bindings: readonly SequenceBinding[]): void {
  const bindingsRef = useRef(bindings)
  bindingsRef.current = bindings

  useEffect(() => {
    let pending: string | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    const reset = () => {
      pending = null
      clearTimeout(timer)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return reset()
      if (isEditableTarget(event.target) || hasOpenOverlay()) return reset()

      const current = bindingsRef.current
      const step = stepKeySequence(pending, event.key, current.map(({ sequence }) => sequence))
      reset()
      if (step.match) {
        event.preventDefault()
        current.find(({ sequence }) => sequence === step.match)?.run()
        return
      }
      if (step.pending !== null) {
        pending = step.pending
        timer = setTimeout(reset, SEQUENCE_TIMEOUT_MS)
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => {
      reset()
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [])
}
