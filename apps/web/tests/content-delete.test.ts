import { describe, expect, test } from "vitest"
import type { DocsContentNavigationSectionDto } from "@doxahq/contracts"

import {
  contentDeleteIncludesPage,
  runContentDelete,
} from "~/lib/dashboard/content-delete"

const navigation: DocsContentNavigationSectionDto[] = [
  {
    slug: "docs",
    label: "Documentation",
    isDefault: true,
    groups: [
      { heading: "Start", groupIndex: 0, hrefs: ["/", "/guide"] },
      { heading: "Reference", groupIndex: 1, hrefs: ["/api"] },
    ],
  },
  {
    slug: "sdk",
    label: "SDK",
    isDefault: false,
    groups: [{ heading: null, groupIndex: null, hrefs: ["/sdk"] }],
  },
]

describe("content deletion", () => {
  test.each([
    {
      edit: { type: "delete_page" as const, href: "/guide" },
      selectedHref: "/guide",
      expected: true,
    },
    {
      edit: { type: "delete_group" as const, sectionSlug: "docs", groupIndex: 0 },
      selectedHref: "/guide",
      expected: true,
    },
    {
      edit: { type: "delete_section" as const, slug: "docs" },
      selectedHref: "/api",
      expected: true,
    },
    {
      edit: { type: "delete_group" as const, sectionSlug: "docs", groupIndex: 1 },
      selectedHref: "/guide",
      expected: false,
    },
    {
      edit: { type: "delete_section" as const, slug: "sdk" },
      selectedHref: "/guide",
      expected: false,
    },
  ])("reports whether $edit.type removes the selected page", ({ edit, selectedHref, expected }) => {
    expect(contentDeleteIncludesPage(edit, selectedHref, navigation)).toBe(expected)
  })

  test("saves an unaffected buffer before it deletes content", async () => {
    const events: string[] = []

    await runContentDelete({
      deletesSelectedPage: false,
      saveBuffer: async () => {
        events.push("save")
        return true
      },
      suspendBuffer: () => {
        events.push("suspend")
        return () => events.push("restore")
      },
      waitForPendingSaves: async () => {
        events.push("wait")
      },
      deleteContent: async () => {
        events.push("delete")
      },
    })

    expect(events).toEqual(["save", "delete"])
  })

  test("suspends an affected buffer and waits for an active save before deletion", async () => {
    const events: string[] = []

    await runContentDelete({
      deletesSelectedPage: true,
      saveBuffer: async () => {
        events.push("save")
        return true
      },
      suspendBuffer: () => {
        events.push("suspend")
        return () => events.push("restore")
      },
      waitForPendingSaves: async () => {
        events.push("wait")
      },
      deleteContent: async () => {
        events.push("delete")
      },
    })

    expect(events).toEqual(["suspend", "wait", "delete"])
  })

  test("restores an affected buffer when deletion fails", async () => {
    const events: string[] = []

    await expect(runContentDelete({
      deletesSelectedPage: true,
      saveBuffer: async () => true,
      suspendBuffer: () => {
        events.push("suspend")
        return () => events.push("restore")
      },
      waitForPendingSaves: async () => {
        events.push("wait")
      },
      deleteContent: async () => {
        events.push("delete")
        throw new Error("delete failed")
      },
    })).rejects.toThrow("delete failed")

    expect(events).toEqual(["suspend", "wait", "delete", "restore"])
  })

  test("does not delete unrelated content when the buffer save fails", async () => {
    let deleted = false

    await expect(runContentDelete({
      deletesSelectedPage: false,
      saveBuffer: async () => false,
      suspendBuffer: () => () => undefined,
      waitForPendingSaves: async () => undefined,
      deleteContent: async () => {
        deleted = true
      },
    })).rejects.toThrow("Save the current page before changing the documentation structure.")

    expect(deleted).toBe(false)
  })
})
