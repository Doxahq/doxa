import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react"

import { THEME_PREFERENCE_LABELS, THEME_PREFERENCES, type ThemePreference } from "~/lib/theme/theme"
import { useTheme } from "~/lib/theme/use-theme"

const THEME_ICONS: Record<ThemePreference, ReactNode> = {
  system: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.2" y="2.2" width="13.6" height="9.2" stroke="currentColor" strokeWidth="1.4" />
      <path stroke="currentColor" strokeWidth="1.4" d="M5 14.4h6M8 11.4v3" />
    </svg>
  ),
  dark: (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" d="M6.2 1.1a6.9 6.9 0 1 0 8.7 8.7A5.6 5.6 0 0 1 6.2 1.1z" />
    </svg>
  ),
  light: (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3.2" fill="currentColor" />
      <path
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="square"
        d="M8 .9v1.8M8 13.3v1.8M.9 8h1.8M13.3 8h1.8M3 3l1.2 1.2M11.8 11.8 13 13M3 13l1.2-1.2M11.8 4.2 13 3"
      />
    </svg>
  ),
}

function ChevronIcon() {
  return (
    <svg className="themes__chevron" width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path stroke="currentColor" strokeWidth="1.4" d="M2 6.5 5 3.5l3 3" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg className="themes__check" width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path stroke="currentColor" strokeWidth="1.6" d="M2 7.5l3.2 3.2L12 3.8" />
    </svg>
  )
}

/**
 * The footer theme menu: System (the default), Dark or Light. The button shows
 * every preference, and CSS on `[data-theme-preference]` keeps only the saved one,
 * so it is right on the first paint. The menu opens upward, because the footer
 * is at the bottom of the page.
 */
export function ThemeSwitch() {
  const { preference, setPreference } = useTheme()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    itemRefs.current[THEME_PREFERENCES.indexOf(preference)]?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
    // The focus moves to the saved option only when the menu opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function close() {
    setOpen(false)
    triggerRef.current?.focus()
  }

  function choose(option: ThemePreference) {
    setPreference(option)
    close()
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = itemRefs.current
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const focusAt = (next: number) => items[(next + items.length) % items.length]?.focus()
    if (event.key === "Escape") close()
    else if (event.key === "Tab") setOpen(false)
    else if (event.key === "ArrowDown") focusAt(index + 1)
    else if (event.key === "ArrowUp") focusAt(index - 1)
    else if (event.key === "Home") focusAt(0)
    else if (event.key === "End") focusAt(items.length - 1)
    else return
    if (event.key !== "Tab") event.preventDefault()
  }

  return (
    <div className="themes" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="themes__trigger"
        aria-label={`Theme: ${THEME_PREFERENCE_LABELS[preference]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        {THEME_PREFERENCES.map((option) => (
          <span key={option} className="themes__current" data-option={option}>
            {THEME_ICONS[option]}
            {THEME_PREFERENCE_LABELS[option]}
          </span>
        ))}
        <ChevronIcon />
      </button>
      {open ? (
        <div id={menuId} className="themes__menu" role="menu" aria-label="Theme" onKeyDown={onMenuKeyDown}>
          {THEME_PREFERENCES.map((option, index) => (
            <button
              key={option}
              ref={(element) => {
                itemRefs.current[index] = element
              }}
              type="button"
              role="menuitemradio"
              aria-checked={option === preference}
              className="themes__option"
              tabIndex={-1}
              onClick={() => choose(option)}
            >
              {THEME_ICONS[option]}
              {THEME_PREFERENCE_LABELS[option]}
              {option === preference ? <CheckIcon /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
