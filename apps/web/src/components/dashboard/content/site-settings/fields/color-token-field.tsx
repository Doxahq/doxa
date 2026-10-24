import { X } from "lucide-react"
import { isCssColor } from "@doxahq/site-config"

import { TextInput } from "~/components/dashboard/content/site-settings/fields/controls"
import type { FieldControlProps } from "~/components/dashboard/content/site-settings/fields/validated-field"
import { cn } from "~/lib/utils"

interface ColorInputProps extends FieldControlProps {
  /** The chosen value, or undefined to use the preset value. */
  value: string | undefined
  /** The value the preset gives. Shown as the placeholder and the swatch. */
  inherited: string
  onValueChange: (value: string | undefined) => void
  label: string
}

/**
 * A CSS color with a swatch and a native picker.
 *
 * The native picker reads and writes hex only. Other forms, such as OKLCH, are
 * typed in the text input. The swatch shows only a value the schema accepts.
 */
export function ColorInput({ value, inherited, onValueChange, label, ...control }: ColorInputProps) {
  const shown = value !== undefined && isCssColor(value) ? value : inherited
  const pickerValue = /^#[\da-f]{6}$/i.test(shown) ? shown : "#000000"

  return (
    <div className="flex items-center gap-2">
      <label
        className="relative size-9 shrink-0 cursor-pointer rounded-md border border-input"
        style={{ backgroundColor: shown }}
        title={`Pick ${label}`}
      >
        <span className="sr-only">Pick {label}</span>
        <input
          type="color"
          value={pickerValue}
          onChange={(event) => onValueChange(event.currentTarget.value)}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
          tabIndex={-1}
        />
      </label>
      <TextInput
        {...control}
        value={value ?? ""}
        onValueChange={(next) => onValueChange(next.trim() === "" ? undefined : next)}
        placeholder={inherited}
        className={cn("font-mono text-xs")}
        spellCheck={false}
      />
      {value !== undefined ? (
        <button
          type="button"
          onClick={() => onValueChange(undefined)}
          className="flex size-9 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
          aria-label={`Use the preset ${label}`}
          title="Use the preset value"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      ) : null}
    </div>
  )
}
