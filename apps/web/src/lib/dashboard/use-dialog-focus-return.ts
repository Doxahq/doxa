import { useRef } from "react"

/** Restores focus for controlled dialogs that do not render a Radix trigger. */
export function useDialogFocusReturn() {
  const previousFocus = useRef<HTMLElement | null>(null)

  return {
    onOpenAutoFocus: () => {
      previousFocus.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    },
    onCloseAutoFocus: (event: Event) => {
      if (!previousFocus.current) return
      event.preventDefault()
      previousFocus.current.focus()
      previousFocus.current = null
    },
  }
}
