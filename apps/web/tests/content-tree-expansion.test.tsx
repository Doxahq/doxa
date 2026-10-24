// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { DocsContentNavigationSectionDto, DocsContentPageDto } from "@doxahq/contracts"

vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react")
  return { Link: ({ children }: { children?: import("react").ReactNode }) => createElement("a", null, children) }
})

import { ContentPageList } from "~/components/dashboard/content/content-page-list"
import { buildContentTree } from "~/lib/dashboard/content-navigation"
import { readExpandedContentRows, writeExpandedContentRows } from "~/lib/dashboard/content-tree-expansion"
import { pageLocksQueryOptions } from "~/lib/queries/page-locks"

const page = (href: string, title: string): DocsContentPageDto => ({ href, title, status: "published", sourcePath: "", icon: null })
const pages = [page("/", "Overview"), page("/guide", "Guide"), page("/api", "API")]
const navigation: DocsContentNavigationSectionDto[] = [
  { slug: "docs", label: "Documentation", isDefault: true, groups: [{ heading: "Introduction", groupIndex: 0, hrefs: ["/", "/guide"] }] },
  { slug: "api", label: "API Reference", isDefault: false, groups: [{ heading: "Endpoints", groupIndex: 0, hrefs: ["/api"] }] },
]
const KEY = "doxa:content-tree:p1"

beforeEach(() => localStorage.clear())
afterEach(cleanup)

function renderList(selectedHref: string | null = null) {
  // No page is locked, so the list never asks the API.
  const client = new QueryClient()
  client.setQueryData(pageLocksQueryOptions("p1").queryKey, [])
  return render(
    <QueryClientProvider client={client}>
      <ContentPageList
        projectId="p1"
        pages={pages}
        navigation={navigation}
        selectedHref={selectedHref}
        home={{ href: null, pending: false }}
        onSelect={vi.fn()}
      />
    </QueryClientProvider>,
  )
}

// A group button also names its page count, so the name starts with the label.
const toggle = (label: string) =>
  screen.getAllByRole("button").find((button) => button.hasAttribute("aria-expanded") && button.textContent?.startsWith(label))!
const isOpen = (label: string) => toggle(label).getAttribute("aria-expanded") === "true"

describe("the saved content tree", () => {
  test("the first render already shows the saved open rows", () => {
    localStorage.setItem(KEY, JSON.stringify(["api", "api:Endpoints#0"]))
    renderList()
    expect(isOpen("API Reference")).toBe(true)
    expect(isOpen("Endpoints")).toBe(true)
    expect(isOpen("Documentation")).toBe(false)
  })

  test("opening and closing a row saves it", () => {
    renderList()
    act(() => void fireEvent.click(toggle("API Reference")))
    expect(readExpandedContentRows("p1")).toEqual(["api"])
    act(() => void fireEvent.click(toggle("API Reference")))
    expect(readExpandedContentRows("p1")).toEqual([])
  })

  test("the open page's branch is open even when the saved state closed it", () => {
    localStorage.setItem(KEY, JSON.stringify([]))
    renderList("/guide")
    expect(isOpen("Documentation")).toBe(true)
    expect(isOpen("Introduction")).toBe(true)
  })

  test("broken or missing storage falls back to the default", () => {
    localStorage.setItem(KEY, "{not json")
    expect(readExpandedContentRows("p1")).toBeNull()
    renderList()
    expect(isOpen("Documentation")).toBe(false)
  })

  test("a save keeps only rows that still exist", () => {
    const tree = buildContentTree(pages, navigation)
    writeExpandedContentRows("p1", tree, new Set(["docs", "removed-section", "docs:Old heading#0"]))
    expect(readExpandedContentRows("p1")).toEqual(["docs"])
  })

  test("each project keeps its own state", () => {
    localStorage.setItem("doxa:content-tree:p2", JSON.stringify(["api"]))
    renderList()
    expect(isOpen("API Reference")).toBe(false)
  })
})
