import { useCallback, useEffect, useRef, useState } from "react"

const COPIED_MS = 1600

/**
 * One "Copied" state for the whole MCP page: copying another value moves the
 * label to its button, as in the design.
 */
export function useCopied() {
  const [copied, setCopied] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = useCallback((text: string, key: string) => {
    try {
      // The label still flips when the clipboard is blocked, like the design.
      navigator.clipboard?.writeText(text).catch(() => {})
    } catch {
      // No clipboard API (old browser or insecure origin).
    }
    setCopied(key)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(null), COPIED_MS)
  }, [])

  const reset = useCallback(() => {
    clearTimeout(timer.current)
    setCopied(null)
  }, [])

  return { copied, copy, reset }
}

export type CopyState = ReturnType<typeof useCopied>
