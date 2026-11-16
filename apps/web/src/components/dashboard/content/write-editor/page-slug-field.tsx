import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { Loader2, Pencil } from "lucide-react"

import { pageSlugError } from "~/lib/dashboard/page-slug"
import { getErrorMessage } from "~/lib/errors"
import { cn } from "~/lib/utils"

export interface PageSlugEdit {
  /** The section path before the slug. Empty in the default section. */
  prefix: string
  slug: string
  /** Renames the page. Throws with a message the field shows. */
  onRename: (slug: string) => Promise<void>
}

/**
 * The class that shows the pencil. Put it on the element whose hover must
 * reveal the pencil, for example the whole property row.
 */
export const PAGE_SLUG_HOVER_GROUP = "group/slug"

const SLUG_TEXT_CLASS = "font-mono text-[12.5px] leading-6"

/**
 * The page URL in the facts strip. A pencil shows on hover, and the pencil or
 * a double click turns the slug into an input. Enter or leaving the input
 * saves, and Escape cancels. While the rename runs, a spinner sits inside the
 * input, so the strip does not move.
 */
export function PageSlugField({
  href,
  edit,
  isIndex = false,
  disabled,
  after,
}: {
  href: string
  /**
   * True for the default page. The site root (`/`) shows it, so the field
   * leads with `/` and an INDEX tag, and keeps the page's own slug after
   * them. The pencil still edits that own slug.
   */
  isIndex?: boolean
  /** Null when the page URL cannot change, for example a section start page. */
  edit: PageSlugEdit | null
  disabled: boolean
  /** Shown after the slug, for example the unpublished dot. */
  after?: ReactNode
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // Refs, not state: Enter and the blur that follows it arrive in one event loop turn.
  const isSavingRef = useRef(false)
  const isClosingRef = useRef(false)
  const refocusRef = useRef(false)
  const canEdit = edit !== null && !disabled

  // A failed save from Enter returns focus to the input once it is enabled again.
  useEffect(() => {
    if (isSaving || !refocusRef.current) return
    refocusRef.current = false
    inputRef.current?.focus()
  }, [isSaving])

  function start() {
    if (!canEdit) return
    isClosingRef.current = false
    setDraft(edit.slug)
    setError(null)
  }

  function cancel() {
    isClosingRef.current = true
    setDraft(null)
    setError(null)
  }

  async function commit(trigger: "enter" | "blur") {
    if (!edit || draft === null || isSavingRef.current) return
    const slug = draft.trim()
    if (slug === edit.slug) {
      cancel()
      return
    }
    const invalid = pageSlugError(slug)
    if (invalid) {
      setError(invalid)
      return
    }
    isSavingRef.current = true
    isClosingRef.current = true
    setIsSaving(true)
    setError(null)
    try {
      await edit.onRename(slug)
      setDraft(null)
    } catch (cause) {
      isClosingRef.current = false
      refocusRef.current = trigger === "enter"
      setError(getErrorMessage(cause, "The page URL could not be changed."))
    } finally {
      isSavingRef.current = false
      setIsSaving(false)
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // The input waits for the rename to finish: no second save, no cancel.
    if (isSavingRef.current && (event.key === "Enter" || event.key === "Escape")) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      void commit("enter")
    } else if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
  }

  if (edit && draft !== null) {
    const prefix = `/${edit.prefix ? `${edit.prefix}/` : ""}`
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className={cn(SLUG_TEXT_CLASS, "text-muted-foreground")}>{prefix}</span>
        <span className="relative inline-flex">
          <input
            ref={inputRef}
            autoFocus
            value={draft}
            onChange={(event) => {
              setDraft(event.currentTarget.value)
              setError(null)
            }}
            onKeyDown={onKeyDown}
            onBlur={() => {
              if (!isClosingRef.current) void commit("blur")
            }}
            onFocus={(event) => event.currentTarget.select()}
            readOnly={isSaving}
            aria-busy={isSaving || undefined}
            aria-label="Page slug"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "page-slug-error" : undefined}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            size={Math.max(draft.length + 1, 12)}
            className={cn(
              SLUG_TEXT_CLASS,
              // The right padding holds the spinner, so saving does not resize the input.
              "-ml-1 h-6 rounded-sm border border-input bg-input-background pr-6 pl-1 text-foreground outline-none focus-visible:border-primary aria-busy:text-muted-foreground aria-[invalid=true]:border-destructive",
            )}
          />
          {isSaving ? (
            <Loader2
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 right-1.5 size-3.5 -translate-y-1/2 text-muted-foreground animate-spin"
            />
          ) : null}
        </span>
        {isSaving ? <span className="sr-only">Saving the page URL</span> : null}
        {isIndex && !error ? (
          <span
            title="This slug is used when another page becomes the default."
            className="truncate text-xs text-muted-foreground"
          >
            Served at / while this is the default page.
          </span>
        ) : null}
        {error ? (
          <span id="page-slug-error" role="alert" className="truncate text-xs text-destructive">
            {error}
          </span>
        ) : null}
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={cn(SLUG_TEXT_CLASS, "text-body")}
        title={canEdit ? "Double-click to edit the slug" : undefined}
        onMouseDown={(event) => {
          // A double click would select a word first. The input opens instead.
          if (canEdit && event.detail > 1) event.preventDefault()
        }}
        onDoubleClick={start}
      >
        {isIndex ? "/" : href}
      </span>
      {isIndex ? (
        <>
          <span
            title="The site root shows this page"
            className="rounded-sm border border-border px-1 font-mono text-[9.5px] leading-4 font-medium tracking-[0.14em] text-muted-foreground uppercase"
          >
            Index
          </span>
          {href !== "/" ? (
            <span className={cn(SLUG_TEXT_CLASS, "text-muted-foreground")}>· {href}</span>
          ) : null}
        </>
      ) : null}
      {after}
      {/* After the dot, so the hidden pencil leaves no gap before it. */}
      {edit ? (
        <button
          type="button"
          onClick={start}
          disabled={disabled}
          aria-label="Edit page slug"
          title="Edit slug"
          className="grid size-6 place-items-center text-muted-foreground opacity-0 transition-opacity group-hover/slug:opacity-100 hover:bg-overlay hover:text-foreground focus-visible:opacity-100 disabled:pointer-events-none [&_svg]:size-3.5"
        >
          <Pencil aria-hidden="true" />
        </button>
      ) : null}
    </span>
  )
}
