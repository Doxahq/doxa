import { createElement, type ComponentType } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"

import * as deleteDialog from "~/components/dashboard/docs-domain-delete-dialog"
import { getDeleteDialogState } from "~/components/dashboard/docs-domain-delete-dialog"
import { Dialog } from "~/components/ui/dialog"

describe("DocsDomainDeleteDialog", () => {
  test("shows an accessible dialog trigger", () => {
    const markup = renderToStaticMarkup(createElement(
      deleteDialog.DocsDomainDeleteDialog,
      {
        hostname: "docs.example.com",
        disabled: false,
        isDeleting: false,
        onDelete: vi.fn(async () => null),
      },
    ))

    expect(markup).toContain(">Delete</button>")
    expect(markup).toContain('aria-haspopup="dialog"')
  })

  test("explains the permanent deletion before showing the action", () => {
    const Content = (
      deleteDialog as typeof deleteDialog & {
        DocsDomainDeleteContent?: ComponentType<{
          hostname: string
          error: string | null
          isDeleting: boolean
          onDelete: () => void
        }>
      }
    ).DocsDomainDeleteContent

    expect(Content).toBeTypeOf("function")
    if (!Content) return

    const markup = renderToStaticMarkup(
      createElement(
        Dialog,
        null,
        createElement(Content, {
          hostname: "docs.example.com",
          error: null,
          isDeleting: false,
          onDelete: vi.fn(),
        }),
      ),
    )

    expect(markup).toContain("docs.example.com")
    expect(markup).toContain("permanently removes")
    expect(markup).toContain("does not remove the CNAME")
    expect(markup).toContain("Delete domain")
    expect(markup).toContain("Keep domain")
  })
})

describe("getDeleteDialogState", () => {
  test("closes the dialog after a successful delete", () => {
    expect(getDeleteDialogState(null)).toEqual({ open: false, error: null })
  })

  test("keeps the dialog open and shows the failure", () => {
    expect(getDeleteDialogState("Cloudflare rejected the delete.")).toEqual({
      open: true,
      error: "Cloudflare rejected the delete.",
    })
  })
})
