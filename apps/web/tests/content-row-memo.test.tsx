// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { DocsContentNavigationSectionDto, DocsContentPageDto } from "@doxahq/contracts"

const renders = vi.hoisted(() => new Map<string, number>())

vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react")
  return { Link: ({ children }: { children?: import("react").ReactNode }) => createElement("a", null, children) }
})
// Each page row reads its review mark once per render, so the call count is the row's render count.
vi.mock("~/lib/dashboard/review-page-marks-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/dashboard/review-page-marks-context")>()
  return {
    ...actual,
    useReviewPageMark: (href: string) => {
      renders.set(href, (renders.get(href) ?? 0) + 1)
      return actual.useReviewPageMark(href)
    },
  }
})

import { ContentPageList } from "~/components/dashboard/content/content-page-list"
import type { ContentStructureActions } from "~/lib/dashboard/use-content-structure"
import { pageLocksQueryOptions } from "~/lib/queries/page-locks"

const page = (href: string, title: string): DocsContentPageDto => ({ href, title, status: "published", sourcePath: "", icon: null })
const pages = [page("/", "Overview"), page("/guide", "Guide"), page("/install", "Install"), page("/faq", "FAQ")]
const navigation: DocsContentNavigationSectionDto[] = [
  { slug: "docs", label: "Documentation", isDefault: true, groups: [{ heading: null, groupIndex: null, hrefs: pages.map(({ href }) => href) }] },
  { slug: "api", label: "API Reference", isDefault: false, groups: [{ heading: null, groupIndex: null, hrefs: [] }] },
]
const home = { href: "/", pending: false }
const onSelect = () => undefined

function structureStub(): ContentStructureActions {
  return { isPending: false, moveNode: vi.fn().mockResolvedValue(undefined) } as unknown as ContentStructureActions
}

afterEach(() => {
  cleanup()
  renders.clear()
})

function renderList(selectedHref: string, structure: ContentStructureActions) {
  // No page is locked, so the list never asks the API.
  const client = new QueryClient()
  client.setQueryData(pageLocksQueryOptions("p1").queryKey, [])
  const list = (href: string, actions: ContentStructureActions) => (
    <QueryClientProvider client={client}>
      <ContentPageList
        projectId="p1"
        pages={pages}
        navigation={navigation}
        selectedHref={href}
        home={home}
        onSelect={onSelect}
        structure={actions}
      />
    </QueryClientProvider>
  )
  const view = render(list(selectedHref, structure))
  return { ...view, update: (href: string, actions: ContentStructureActions) => view.rerender(list(href, actions)) }
}

describe("content sidebar rows", () => {
  test("a page switch re-renders only the old and the new selected row", () => {
    const structure = structureStub()
    const view = renderList("/", structure)
    expect(renders.get("/install")).toBeGreaterThan(0)
    const before = new Map(renders)

    // The editor's structure object changes on every page switch.
    act(() => view.update("/guide", { ...structure }))

    const rendered = pages.map(({ href }) => href).filter((href) => renders.get(href) !== before.get(href))
    expect(rendered.sort()).toEqual(["/", "/guide"])
    expect(view.container.querySelector('[aria-current="page"]')?.textContent).toContain("Guide")
  })

  test("a row action uses the latest structure, even when the row did not re-render", () => {
    const first = structureStub()
    const view = renderList("/", first)
    const latest = structureStub()
    act(() => view.update("/guide", latest))

    const installRow = view.container.querySelector('[data-drag-row="page:/install"]')
      ?? [...view.container.querySelectorAll("[data-drag-row]")].find((row) => row.textContent?.includes("Install"))
    expect(installRow).toBeTruthy()
    act(() => void fireEvent.keyDown(installRow!, { key: "ArrowDown", altKey: true }))

    expect(latest.moveNode).toHaveBeenCalledTimes(1)
    expect(first.moveNode).not.toHaveBeenCalled()
  })
})
