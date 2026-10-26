import { useState, type KeyboardEvent } from "react"
import { X } from "lucide-react"

import type { FieldControlProps } from "~/components/dashboard/content/site-settings/fields/validated-field"
import { cn } from "~/lib/utils"

interface KeywordInputProps extends FieldControlProps {
  keywords: readonly string[]
  onChange: (keywords: string[]) => void
  max: number
  /** What one chip is, for the placeholder and the remove buttons. Default "keyword". */
  itemNoun?: string
  placeholder?: string
  /** Read only: chips show, nothing changes. */
  disabled?: boolean
}

/** Keywords as removable chips. Enter or a comma adds the typed keyword. */
export function KeywordInput({
  keywords,
  onChange,
  max,
  onBlur,
  itemNoun = "keyword",
  placeholder = `Add a ${itemNoun}`,
  disabled = false,
  ...control
}: KeywordInputProps) {
  const [draft, setDraft] = useState("")
  const isFull = keywords.length >= max

  function commit() {
    const keyword = draft.trim()
    setDraft("")
    if (!keyword || keywords.includes(keyword) || isFull) return
    onChange([...keywords, keyword])
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault()
      commit()
    } else if (event.key === "Backspace" && draft === "" && keywords.length > 0) {
      onChange(keywords.slice(0, -1))
    }
  }

  return (
    <div
      className={cn(
        "flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring",
        control["aria-invalid"] && "border-destructive",
      )}
    >
      {keywords.map((keyword, index) => (
        <span key={keyword} className="inline-flex items-center gap-1 rounded-sm border border-border bg-muted/40 px-2 py-0.5 font-mono text-xs">
          {keyword}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(keywords.filter((_, position) => position !== index))}
            className="text-muted-foreground hover:text-foreground"
            aria-label={`Remove ${itemNoun} ${keyword}`}
          >
            <X aria-hidden="true" className="size-3" />
          </button>
        </span>
      ))}
      <input
        {...control}
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          commit()
          onBlur()
        }}
        disabled={disabled || isFull}
        placeholder={isFull ? `${max} ${itemNoun}s` : placeholder}
        className="min-w-32 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
      />
    </div>
  )
}
