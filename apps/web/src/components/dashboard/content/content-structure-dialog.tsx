import { useEffect, useState } from "react"
import { useForm } from "@tanstack/react-form"
import {
  DOCS_PAGE_SLUG_PATTERN,
  DOCS_SECTION_SLUG_PATTERN,
} from "@doxahq/contracts"

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
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { getErrorMessage } from "~/lib/errors"

export interface ContentStructureDialogRequest {
  title: string
  description: string
  nameLabel: string
  initialName?: string
  initialSlug?: string
  slugKind?: "section" | "page"
  hrefPrefix?: string
  submitLabel: string
  onSubmit: (values: { name: string; slug: string }) => Promise<void>
}

interface ContentStructureDialogProps {
  request: ContentStructureDialogRequest | null
  onOpenChange: (open: boolean) => void
}

/** Shared create and rename dialog for sections, groups, and pages. */
export function ContentStructureDialog({
  request,
  onOpenChange,
}: ContentStructureDialogProps) {
  const [submitError, setSubmitError] = useState<string | null>(null)
  const form = useForm({
    defaultValues: {
      name: request?.initialName ?? "",
      slug: request?.initialSlug ?? "",
    },
    onSubmit: async ({ value }) => {
      setSubmitError(null)
      try {
        await request?.onSubmit(value)
        onOpenChange(false)
      } catch (cause) {
        setSubmitError(getErrorMessage(cause, "Failed to save this change."))
      }
    },
  })

  useEffect(() => {
    setSubmitError(null)
    form.reset({
      name: request?.initialName ?? "",
      slug: request?.initialSlug ?? "",
    })
  }, [request])

  return (
    <Dialog open={request !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{request?.title}</DialogTitle>
          <DialogDescription>{request?.description}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            event.stopPropagation()
            void form.handleSubmit()
          }}
        >
          <DialogBody className="space-y-4">
            {submitError ? <p className="text-sm text-destructive">{submitError}</p> : null}
            <form.Field
              name="name"
              validators={{
                onChange: ({ value }) => validateName(value),
                onSubmit: ({ value }) => validateName(value),
              }}
            >
              {(field) => (
                <div className="space-y-1.5">
                  <Label htmlFor={field.name}>{request?.nameLabel}</Label>
                  <Input
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.currentTarget.value)}
                    autoFocus
                  />
                  <FieldError errors={field.state.meta.errors} />
                </div>
              )}
            </form.Field>
            {request?.slugKind ? (
              <form.Field
                name="slug"
                validators={{
                  onChange: ({ value }) => validateSlug(value, request.slugKind ?? "page"),
                  onSubmit: ({ value }) => validateSlug(value, request.slugKind ?? "page"),
                }}
              >
                {(field) => (
                  <div className="space-y-1.5">
                    <Label htmlFor={field.name}>Slug</Label>
                    <Input
                      id={field.name}
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.currentTarget.value)}
                      className="font-mono"
                    />
                    <FieldError errors={field.state.meta.errors} />
                    {request.slugKind === "page" ? (
                      <p className="font-mono text-[10px] text-muted-foreground">
                        {joinHref(request.hrefPrefix ?? "", field.state.value)}
                      </p>
                    ) : null}
                  </div>
                )}
              </form.Field>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting]}>
              {([canSubmit, isSubmitting]) => (
                <Button type="submit" disabled={!canSubmit || isSubmitting}>
                  {isSubmitting ? "Saving…" : request?.submitLabel}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function FieldError({ errors }: { errors: readonly unknown[] }) {
  const message = errors.find((error): error is string => typeof error === "string")
  return message ? <p className="text-xs text-destructive">{message}</p> : null
}

function joinHref(prefix: string, slug: string): string {
  const path = [prefix, slug.trim()].filter(Boolean).join("/")
  return `/${path}`.replace(/\/+/g, "/")
}

function validateName(value: string): string | undefined {
  return value.trim().length > 0 && value.trim().length <= 120
    ? undefined
    : "Enter a name between 1 and 120 characters."
}

function validateSlug(
  value: string,
  kind: "section" | "page",
): string | undefined {
  const pattern = kind === "section" ? DOCS_SECTION_SLUG_PATTERN : DOCS_PAGE_SLUG_PATTERN
  return pattern.test(value.trim())
    ? undefined
    : "Use lowercase letters, numbers, and single hyphens between words."
}
