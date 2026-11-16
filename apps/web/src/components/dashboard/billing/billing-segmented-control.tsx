import type { ReactNode } from "react"

import { cn } from "~/lib/utils"

export interface SegmentedOption<Value extends string> {
  value: Value
  label: ReactNode
}

/** A row of choices in one bordered box: one radio group, the chosen one filled. */
export function SegmentedControl<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  /** The group's accessible name. */
  label: string
  value: Value
  options: readonly SegmentedOption<Value>[]
  onChange: (value: Value) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex w-fit max-w-full flex-wrap border border-border">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "px-3 py-1.5 text-[13px] whitespace-nowrap transition-colors duration-75",
            value === option.value ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
