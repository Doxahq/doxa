// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { LUCIDE_ICON_DATA } from "@doxahq/docs-prose/icons/lucide"
import { LUCIDE_ICON_TAGS } from "@doxahq/docs-prose/icons/lucide-tags"
import { afterEach, describe, expect, test } from "vitest"

import { DocsIcon, DocsPageIcon, resolveDocsIcon } from "~/components/dashboard/content/docs-icon"
import { currentIconName, loadDocsIcons, SUGGESTED_ICON_SEARCH_WORDS } from "~/lib/dashboard/docs-icons"
import { buildIconSearchEntries, searchIcons } from "~/lib/dashboard/icon-search"

afterEach(cleanup)

// The full icon set is a module-level cache, so the tests that see it still
// loading run first.
describe("docs icons before the full set loads", () => {
  test("a suggested icon draws at once, and another icon keeps an empty frame", () => {
    const { container } = render(
      <>
        <DocsIcon name="rocket" className="rocket" />
        <DocsIcon name="anchor" className="anchor" />
      </>,
    )
    expect(container.querySelector("svg.rocket")?.childElementCount).toBeGreaterThan(0)
    expect(container.querySelector("svg.anchor")?.childElementCount).toBe(0)
  })

  test("a renamed suggested icon knows its current name without the full set", () => {
    expect(currentIconName("circleHelp", null)).toBe("circleQuestionMark")
    expect(currentIconName("anchor", null)).toBeNull()
  })
})

describe("docs icons", () => {
  test("any Lucide icon draws once the full set loads", async () => {
    const { container } = render(<DocsIcon name="anchor" className="anchor" />)
    await act(() => loadDocsIcons())
    expect(container.querySelector("svg.anchor")?.childElementCount).toBeGreaterThan(0)
  })

  test("an old Lucide name follows the rename", async () => {
    await act(() => loadDocsIcons())
    expect(currentIconName("helpCircle", LUCIDE_ICON_DATA)).toBe("circleQuestionMark")
    expect(currentIconName("book-open", LUCIDE_ICON_DATA)).toBe("bookOpen")
    expect(currentIconName("notAnIcon", LUCIDE_ICON_DATA)).toBeNull()
  })

  test("a page with an unknown icon shows the plain page glyph", async () => {
    await act(() => loadDocsIcons())
    const { container } = render(<DocsPageIcon name="notAnIcon" className="page" />)
    expect(container.querySelector("svg.page")?.classList.contains("lucide-file-text")).toBe(true)
  })

  test("a card resolves each name to one stable component", () => {
    expect(resolveDocsIcon("book-open")).toBe(resolveDocsIcon("bookOpen"))
    expect(resolveDocsIcon("bad name!")).toBeNull()
  })
})

describe("icon search", () => {
  const entries = buildIconSearchEntries(Object.keys(LUCIDE_ICON_DATA.icons), LUCIDE_ICON_TAGS, SUGGESTED_ICON_SEARCH_WORDS)

  test("an exact name ranks first", () => {
    expect(searchIcons(entries, "terminal")[0]).toBe("terminal")
    expect(searchIcons(entries, "book open")[0]).toBe("bookOpen")
    expect(searchIcons(entries, "book-open")[0]).toBe("bookOpen")
    expect(searchIcons(entries, "bookopen")[0]).toBe("bookOpen")
  })

  test("every word must match", () => {
    const matches = searchIcons(entries, "arrow up")
    expect(matches.length).toBeGreaterThan(0)
    for (const name of matches.slice(0, 20)) expect(name.toLowerCase()).toMatch(/arrow|up/)
    expect(searchIcons(entries, "arrow zzzz")).toEqual([])
  })

  test("Lucide's search words and the suggested words find icons", () => {
    expect(searchIcons(entries, "reading")).toContain("bookOpen")
    expect(searchIcons(entries, "faq")).toContain("circleQuestionMark")
  })

  test("a name ranks above a search word", () => {
    const matches = searchIcons(entries, "key")
    expect(matches[0]).toBe("key")
    const byWordOnly = entries.find((entry) => entry.tags.includes("key") && !entry.compact.includes("key"))!
    const byName = matches.filter((name) => name.toLowerCase().includes("key"))
    expect(matches.indexOf(byWordOnly.name)).toBeGreaterThan(matches.indexOf(byName.at(-1)!))
  })

  test("an empty search keeps the list as it is", () => {
    expect(searchIcons(entries, "  ")).toHaveLength(entries.length)
  })
})
