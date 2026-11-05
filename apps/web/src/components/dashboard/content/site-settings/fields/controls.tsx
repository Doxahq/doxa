import type { ChangeEvent, ComponentProps, KeyboardEvent, ReactNode } from "react"

import {
  Select as SelectRoot,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select"
import { cn } from "~/lib/utils"

const fieldControlClass =
  "w-full rounded-md border border-input bg-input-background px-3 text-sm text-foreground transition-colors duration-75 placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive"

type NativeInputProps = Omit<ComponentProps<"input">, "value" | "onChange">

/** A text input that reports the new string, not the event. */
export function TextInput({
  value,
  onValueChange,
  className,
  ...props
}: NativeInputProps & { value: string; onValueChange: (value: string) => void }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onValueChange(event.currentTarget.value)}
      className={cn(fieldControlClass, "h-9", className)}
      {...props}
    />
  )
}

export function TextArea({
  value,
  onValueChange,
  className,
  ...props
}: Omit<ComponentProps<"textarea">, "value" | "onChange"> & {
  value: string
  onValueChange: (value: string) => void
}) {
  return (
    <textarea
      value={value}
      onChange={(event) => onValueChange(event.currentTarget.value)}
      className={cn(fieldControlClass, "min-h-20 resize-y py-2 leading-6", className)}
      {...props}
    />
  )
}

export interface SelectOption<TValue extends string> {
  value: TValue
  label: string
  /** Visible, but a person cannot choose it. */
  disabled?: boolean
}

/**
 * Radix reserves the empty string for "nothing selected", so an option whose
 * value is "" travels under this key inside the list.
 */
const EMPTY_OPTION_KEY = "__empty__"

const toOptionKey = (value: string): string => (value === "" ? EMPTY_OPTION_KEY : value)

/**
 * A dropdown in the dashboard theme. It keeps the API of the old native
 * select: the options, the value and the new value, not an event.
 */
export function Select<TValue extends string>({
  value,
  options,
  onValueChange,
  placeholder,
  disabled,
  className,
  container,
  ...props
}: Omit<ComponentProps<typeof SelectTrigger>, "value" | "onChange" | "children" | "defaultValue"> & {
  value: TValue
  options: readonly SelectOption<TValue>[]
  onValueChange: (value: TValue) => void
  placeholder?: string
  /**
   * Where the list renders, `document.body` by default. A select inside an
   * editor bubble menu passes the menu, so the open list keeps the menu open.
   */
  container?: ComponentProps<typeof SelectContent>["container"]
}) {
  const selected = options.some((option) => option.value === value) ? toOptionKey(value) : ""
  return (
    <SelectRoot
      value={selected}
      disabled={disabled}
      onValueChange={(key) => {
        const next = options.find((option) => toOptionKey(option.value) === key)
        if (next) onValueChange(next.value)
      }}
    >
      <SelectTrigger className={className} {...props}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent container={container}>
        {options.map((option) => (
          <SelectItem key={option.value} value={toOptionKey(option.value)} disabled={option.disabled ?? false}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  )
}

/** An on/off control. It is a button with the `switch` role, as ARIA requires. */
export function Switch({
  checked,
  onCheckedChange,
  className,
  ...props
}: Omit<ComponentProps<"button">, "onChange" | "role" | "type"> & {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-75 disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "border-primary bg-primary" : "border-input bg-muted",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "block size-3.5 rounded-full bg-foreground transition-transform duration-75",
          checked ? "translate-x-[18px]" : "translate-x-[2px]",
        )}
      />
    </button>
  )
}

/** A row with a title, a description, and a switch, for feature flags. */
export function SwitchRow({
  id,
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
  badge,
}: {
  id: string
  title: string
  description: ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  badge?: ReactNode
}) {
  const descriptionId = `${id}-description`
  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <label htmlFor={id} className="text-sm font-medium text-foreground">
            {title}
          </label>
          {badge}
        </div>
        <p id={descriptionId} className="text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-describedby={descriptionId}
        className="mt-0.5"
      />
    </div>
  )
}

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown"])
const PREVIOUS_KEYS = new Set(["ArrowLeft", "ArrowUp"])

/**
 * Arrow-key movement for a group of `role="radio"` buttons, as the ARIA radio
 * group pattern requires: arrows select and focus the next option, and only
 * the selected option is in the Tab order.
 */
export function onRadioGroupKeyDown<TValue>(
  event: KeyboardEvent<HTMLElement>,
  values: readonly TValue[],
  current: TValue,
  select: (value: TValue) => void,
) {
  const step = NEXT_KEYS.has(event.key) ? 1 : PREVIOUS_KEYS.has(event.key) ? -1 : 0
  if (step === 0 || values.length === 0) return
  event.preventDefault()
  const index = Math.max(0, values.indexOf(current))
  const next = (index + step + values.length) % values.length
  select(values[next])
  // Disabled radios are skipped, so `values` lists only the enabled ones.
  const radios = event.currentTarget
    .closest('[role="radiogroup"]')
    ?.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)')
  radios?.[next]?.focus()
}

/** A disabled option is shown struck through, for a choice the rules forbid. */
export type SegmentedOption<TValue extends string> = SelectOption<TValue>

/**
 * A single choice from a few options, shown as joined buttons. `disabled`
 * makes the whole group read only; a disabled option stays visible so the
 * reader sees what is not offered.
 */
export function SegmentedControl<TValue extends string>({
  value,
  options,
  onValueChange,
  label,
  id,
  disabled = false,
}: {
  value: TValue
  options: readonly SegmentedOption<TValue>[]
  onValueChange: (value: TValue) => void
  label: string
  id?: string
  disabled?: boolean
}) {
  const enabledValues = disabled ? [] : options.filter((option) => !option.disabled).map((option) => option.value)
  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className="inline-flex overflow-hidden rounded-md border border-border"
    >
      {options.map((option) => {
        const selected = option.value === value
        const unavailable = disabled || option.disabled === true
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={unavailable}
            tabIndex={selected && !unavailable ? 0 : -1}
            onClick={() => onValueChange(option.value)}
            onKeyDown={(event) => onRadioGroupKeyDown(event, enabledValues, value, onValueChange)}
            className={cn(
              "px-3 py-1.5 text-xs font-medium transition-colors duration-75 disabled:cursor-not-allowed",
              selected ? "bg-muted/60 text-primary" : "text-muted-foreground enabled:hover:text-foreground",
              option.disabled && "text-faint line-through",
              disabled && selected && "text-foreground",
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** A bordered settings card: mono title and description, then its fields. */
export function SettingsSection({
  title,
  description,
  children,
  actions,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <section className="surface-card">
      <header className="flex items-start justify-between gap-4 border-b border-divider px-5 py-4">
        <div className="space-y-1">
          <h3 className="font-mono text-xs font-bold tracking-[0.14em] text-foreground uppercase">
            {title}
          </h3>
          {description ? <p className="text-[13px] leading-5 text-muted-foreground">{description}</p> : null}
        </div>
        {actions}
      </header>
      <div className="space-y-5 px-5 py-5">{children}</div>
    </section>
  )
}
