import { Check, Copy } from "lucide-react"

import { Button } from "~/components/ui/button"
import { useCopied, type CopyState } from "~/lib/mcp/copied"
import { cn } from "~/lib/utils"

export interface DnsRecordFieldValue {
  label: string
  value: string
  /** Names the copy button, such as "DNS name". No button when it is absent. */
  copyLabel?: string
}

/** The values of one DNS record, each in a box, with a copy button for the values to paste. */
export function DnsRecordFields({ fields }: { fields: readonly DnsRecordFieldValue[] }) {
  // One state for the record, so copying a second value moves the check mark to it.
  const copyState = useCopied()

  return (
    <dl className="grid gap-2 sm:grid-cols-[minmax(6rem,auto)_minmax(0,1fr)_minmax(0,1.6fr)]">
      {fields.map((field) => (
        <DnsRecordField key={field.label} field={field} copyState={copyState} />
      ))}
    </dl>
  )
}

function DnsRecordField({ field, copyState }: { field: DnsRecordFieldValue; copyState: CopyState }) {
  const { label, value, copyLabel } = field

  return (
    <div className="min-w-0 rounded-md border border-border bg-muted/10 px-3 py-2">
      <dt className="font-mono text-[11px] tracking-[0.16em] text-label uppercase">
        {label}
      </dt>
      <dd className="mt-1 flex min-h-7 min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 break-all font-mono text-xs leading-5 text-foreground">
          {value}
        </span>
        {copyLabel ? (
          <CopyValueButton
            label={copyLabel}
            isCopied={copyState.copied === label}
            onCopy={() => copyState.copy(value, label)}
          />
        ) : null}
      </dd>
    </div>
  )
}

/** An icon button whose copy icon turns into a check mark for a moment, like the docs code blocks. */
function CopyValueButton({ label, isCopied, onCopy }: { label: string; isCopied: boolean; onCopy: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7! shrink-0"
      aria-label={isCopied ? `${label} copied` : `Copy ${label}`}
      title={`Copy ${label}`}
      onClick={onCopy}
    >
      <span className="relative size-3.5 shrink-0">
        <Copy
          aria-hidden="true"
          className={cn(
            "absolute inset-0 size-3.5 transition-[opacity,scale] duration-150",
            isCopied ? "scale-90 opacity-0" : "scale-100 opacity-100",
          )}
        />
        <Check
          aria-hidden="true"
          className={cn(
            "absolute inset-0 size-3.5 text-success transition-[opacity,scale] duration-150",
            isCopied ? "scale-100 opacity-100" : "scale-90 opacity-0",
          )}
        />
      </span>
    </Button>
  )
}
