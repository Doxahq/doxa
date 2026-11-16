import { useState, type ReactNode } from "react"
import type { GenerationConfirmationReason } from "@doxahq/contracts"
import { AlertCircle, ExternalLink, Loader2 } from "lucide-react"

import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import { GENERATION_REVIEW_DOCS_URL } from "~/lib/dashboard/external-links"
import { cn } from "~/lib/utils"

/** The person's answer. `seed` starts from the pages written in the editor. */
export interface GenerationStartChoice {
  seed: boolean
}

/** The wording of each reason that a start asks for confirmation. */
const CONFIRMATION_COPY: Record<
  GenerationConfirmationReason,
  { title: string; confirmLabel: string; facts: readonly string[] }
> = {
  unchanged_source: {
    title: "No source changes",
    confirmLabel: "Generate anyway",
    facts: [],
  },
  rerun_succeeded: {
    title: "Run this generation again?",
    confirmLabel: "Re-run anyway",
    facts: [],
  },
  editor_content: {
    title: "Your site has pages written in the editor",
    confirmLabel: "Generate for review",
    facts: [
      "The generated docs go to a review. You decide on each page before anything goes live.",
      "When you publish, your current pages stay in a backup branch.",
    ],
  },
}

const SEED_OPTIONS = [
  {
    seed: true,
    title: "Use my pages as a guide",
    description:
      "The generation keeps your structure and uses your text as input. Pages that it leaves out stay as you wrote them.",
    recommended: true,
  },
  {
    seed: false,
    title: "Start from my code only",
    description: "The generation ignores your pages. You still compare and decide before anything goes live.",
    recommended: false,
  },
] as const

interface GenerationStartConfirmationDialogProps {
  open: boolean
  reason: GenerationConfirmationReason
  message: string
  isPending: boolean
  error: string | null
  onOpenChange: (open: boolean) => void
  onConfirm: (choice: GenerationStartChoice) => void
}

export function GenerationStartConfirmationDialog({
  open,
  reason,
  message,
  isPending,
  error,
  onOpenChange,
  onConfirm,
}: GenerationStartConfirmationDialogProps) {
  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen && isPending) return
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="overscroll-contain shadow-none"
        onEscapeKeyDown={(event) => {
          if (isPending) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (isPending) event.preventDefault()
        }}
      >
        <GenerationStartConfirmationContent
          reason={reason}
          message={message}
          isPending={isPending}
          error={error}
          onCancel={() => onOpenChange(false)}
          onConfirm={onConfirm}
        />
      </DialogContent>
    </Dialog>
  )
}

export function GenerationStartConfirmationContent({
  reason = "unchanged_source",
  message,
  isPending,
  error,
  estimate,
  onCancel,
  onConfirm,
}: {
  reason?: GenerationConfirmationReason
  message: string
  isPending: boolean
  error: string | null
  /**
   * The credit estimate panel. No caller passes it since 2026-11-15: the
   * estimate is hidden until there is data for a reliable range.
   */
  estimate?: ReactNode
  onCancel: () => void
  onConfirm: (choice: GenerationStartChoice) => void
}) {
  // Seed mode is the default: the person wrote these pages.
  const [seed, setSeed] = useState(true)
  const copy = CONFIRMATION_COPY[reason]
  const asksForSeed = reason === "editor_content"

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-balance">{copy.title}</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <DialogDescription className="text-pretty">
          {message}
        </DialogDescription>
        {asksForSeed ? (
          <div role="radiogroup" aria-label="How the generation starts" className="flex flex-col gap-2">
            {SEED_OPTIONS.map((option) => (
              <SeedOption
                key={option.title}
                {...option}
                selected={seed === option.seed}
                disabled={isPending}
                onSelect={() => setSeed(option.seed)}
              />
            ))}
          </div>
        ) : null}
        {copy.facts.length > 0 ? (
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-body">
            {copy.facts.map((fact) => <li key={fact}>{fact}</li>)}
          </ul>
        ) : null}
        {asksForSeed ? (
          <a
            href={GENERATION_REVIEW_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-primary-text underline-offset-4 hover:underline"
          >
            How generation reviews work
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>
        ) : null}
        {estimate}
        {error ? (
          <Alert variant="destructive" aria-live="polite">
            <AlertCircle aria-hidden="true" />
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isPending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={isPending}
          onClick={() => onConfirm({ seed: asksForSeed && seed })}
        >
          {isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          {isPending ? "Starting…" : copy.confirmLabel}
        </Button>
      </DialogFooter>
    </>
  )
}

function SeedOption(props: {
  title: string
  description: string
  recommended: boolean
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      disabled={props.disabled}
      onClick={props.onSelect}
      className={cn(
        "flex flex-col gap-0.5 border px-3 py-2.5 text-left transition-colors",
        props.selected
          ? "border-primary bg-primary-wash"
          : "border-border hover:bg-overlay",
      )}
    >
      <span className="text-sm font-medium text-foreground">
        {props.title}
        {props.recommended ? (
          <span className="ml-2 font-mono text-[10px] tracking-[0.12em] text-primary-text uppercase">
            Recommended
          </span>
        ) : null}
      </span>
      <span className="text-[13px] text-muted-foreground">{props.description}</span>
    </button>
  )
}
