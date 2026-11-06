import { QueryClient } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"

import { saveAndStartNote } from "~/components/dashboard/doxabot/instructions/save-and-start-bar"
import { InstructionsOfferContent } from "~/components/dashboard/instructions-offer-dialog"
import { Dialog } from "~/components/ui/dialog"
import { loadInstructionsOffer, shouldOfferInstructions } from "~/lib/dashboard/instructions-offer"
import { parseInstructionsSearch } from "~/lib/dashboard/instructions-search"
import { dashboardQueryKeys } from "~/lib/queries/dashboard"
import { doxabotInstructionsQueryKey } from "~/lib/queries/doxabot-instructions"

const PROJECT_ID = "project-1"

function clientWith(input: { generationCount: number; hasInstructions: boolean }): QueryClient {
  const queryClient = new QueryClient()
  queryClient.setQueryData(dashboardQueryKeys.generations(PROJECT_ID), {
    pages: [{ generations: Array.from({ length: input.generationCount }, (_, id) => ({ id })), nextCursor: null }],
    pageParams: [null],
  })
  queryClient.setQueryData(doxabotInstructionsQueryKey(PROJECT_ID), {
    current: input.hasInstructions ? { version: 1 } : null,
    history: [],
  })
  return queryClient
}

describe("instructions offer", () => {
  test.each([
    [{ canConfigureInstructions: true, hasGenerations: false, hasInstructions: false }, true],
    [{ canConfigureInstructions: false, hasGenerations: false, hasInstructions: false }, false],
    [{ canConfigureInstructions: true, hasGenerations: true, hasInstructions: false }, false],
    [{ canConfigureInstructions: true, hasGenerations: false, hasInstructions: true }, false],
  ])("decides from %j", (input, expected) => {
    expect(shouldOfferInstructions(input)).toBe(expected)
  })

  test("offers before the first generation of a project without instructions", async () => {
    const queryClient = clientWith({ generationCount: 0, hasInstructions: false })

    await expect(loadInstructionsOffer(queryClient, PROJECT_ID, true)).resolves.toBe(true)
  })

  test("does not offer after an earlier generation", async () => {
    const queryClient = clientWith({ generationCount: 1, hasInstructions: false })

    await expect(loadInstructionsOffer(queryClient, PROJECT_ID, true)).resolves.toBe(false)
  })

  test("does not offer when instructions are saved", async () => {
    const queryClient = clientWith({ generationCount: 0, hasInstructions: true })

    await expect(loadInstructionsOffer(queryClient, PROJECT_ID, true)).resolves.toBe(false)
  })

  test("does not read anything for a person who cannot change the instructions", async () => {
    const queryClient = new QueryClient()

    await expect(loadInstructionsOffer(queryClient, PROJECT_ID, false)).resolves.toBe(false)
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
  })

  test("lets the generation start when the lookup fails", async () => {
    const queryClient = clientWith({ generationCount: 0, hasInstructions: false })
    queryClient.removeQueries({ queryKey: doxabotInstructionsQueryKey(PROJECT_ID) })
    queryClient.setDefaultOptions({ queries: { retry: false } })
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline")
    }))
    try {
      await expect(loadInstructionsOffer(queryClient, PROJECT_ID, true)).resolves.toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test("shows the question, the recommendation, and both answers", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Dialog,
        null,
        createElement(InstructionsOfferContent, {
          onCancel: () => undefined,
          onAddInstructions: () => undefined,
          onGenerateWithout: () => undefined,
        }),
      ),
    )

    expect(markup).toContain("Do you want to provide instructions?")
    expect(markup).toContain("We recommend")
    expect(markup).toContain(">Add instructions<")
    expect(markup).toContain(">Generate without instructions<")
    expect(markup).toContain(">Cancel<")
    expect(markup).not.toContain("lucide-arrow-left")
  })

  test("goes back with an icon as a step in another dialog", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Dialog,
        null,
        createElement(InstructionsOfferContent, {
          isStep: true,
          onCancel: () => undefined,
          onAddInstructions: () => undefined,
          onGenerateWithout: () => undefined,
        }),
      ),
    )

    expect(markup).toContain("lucide-arrow-left")
    expect(markup).toContain("Back</button>")
    expect(markup).not.toContain(">Cancel<")
  })
})

describe("instructions page search", () => {
  test("opens the generation step only for the exact value", () => {
    expect(parseInstructionsSearch({ then: "generate" })).toEqual({ then: "generate" })
    expect(parseInstructionsSearch({ then: "publish" })).toEqual({})
    expect(parseInstructionsSearch({})).toEqual({})
  })
})

describe("save and start note", () => {
  test("names the version that a save creates", () => {
    expect(saveAndStartNote({ isDirty: true, validationMessage: null, savedVersion: null })).toContain("version 1")
    expect(saveAndStartNote({ isDirty: true, validationMessage: null, savedVersion: 2 })).toContain("version 3")
  })

  test("shows why a draft cannot be saved", () => {
    expect(saveAndStartNote({ isDirty: true, validationMessage: "Too long.", savedVersion: null })).toBe("Too long.")
  })

  test("says what a start without a draft uses", () => {
    expect(saveAndStartNote({ isDirty: false, validationMessage: null, savedVersion: null })).toContain("without them")
    expect(saveAndStartNote({ isDirty: false, validationMessage: null, savedVersion: 4 })).toContain("version 4")
  })
})
