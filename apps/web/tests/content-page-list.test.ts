import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, test, vi } from "vitest"
import type {
  DocsContentNavigationSectionDto,
  DocsContentPageDto,
} from "@doxahq/contracts"

vi.mock("@tanstack/react-router", async () => {
  const { createElement: createReactElement } = await import("react")

  return {
    Link: ({ children }: { children?: import("react").ReactNode }) =>
      createReactElement("a", null, children),
  }
})

import { ContentPageList } from "~/components/dashboard/content/content-page-list"

const pages: DocsContentPageDto[] = [
  createPage("/", "Overview", "edited"),
  createPage("/guide", "Guide"),
  createPage("/api", "API"),
]

const navigation: DocsContentNavigationSectionDto[] = [
  {
    slug: "docs",
    label: "Documentation",
    isDefault: true,
    groups: [
      { heading: "Introduction", groupIndex: 0, hrefs: ["/", "/guide"] },
    ],
  },
  {
    slug: "api",
    label: "API Reference",
    isDefault: false,
    groups: [{ heading: "Endpoints", groupIndex: 0, hrefs: ["/api"] }],
  },
]

describe("ContentPageList", () => {
  beforeEach(() => vi.clearAllMocks())

  test("renders sections and groups with the selected page branch open", () => {
    const markup = renderList(navigation, "/")

    expect(markup).toContain("Documentation")
    expect(markup).toContain("API Reference")
    expect(markup).toContain("Introduction")
    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('aria-current="page"')
    expect(markup).toContain('aria-label="Documentation pages"')
  })

  test("labels only the default page, with a label that steps aside on hover", () => {
    const markup = renderList(navigation, "/guide", "/guide")
    const labels = markup.match(/<span[^>]*>Default<\/span>/g) ?? []

    expect(labels).toHaveLength(1)
    expect(labels[0]).toContain("group-hover/row:invisible")
    // Focus stays in the row after its menu closes, so focus must not hide it.
    expect(labels[0]).not.toContain("focus-within")
    expect(renderList(navigation, "/guide", null)).not.toContain(">Default</span>")
  })

  test("shows a spinner instead of the label while a new default is saved", () => {
    const markup = renderList(navigation, "/guide", "/guide", true)

    expect(markup).toContain('aria-label="Setting the default page"')
    expect(markup).not.toContain(">Default</span>")
  })

  test("renders accessible create and rename actions for every tree row kind", () => {
    const markup = renderList(navigation, "/")

    expect(markup).toContain('aria-label="New section"')
    expect(markup).toContain('aria-label="Actions for the section Documentation"')
    expect(markup).toContain('aria-label="New group in Documentation"')
    expect(markup).toContain('aria-label="Actions for the group Introduction"')
    expect(markup).toContain('aria-label="New page in Introduction"')
    expect(markup).toContain('aria-label="Actions for the page Overview"')
  })

  test("explains that the default section delete action is unavailable", () => {
    const markup = renderList(navigation, "/")

    expect(markup).toContain(
      'aria-description="The default section cannot be deleted."',
    )
    expect(
      markup.match(/aria-description="The default section cannot be deleted\."/g),
    ).toHaveLength(1)
  })

  test("gives each row one create action, so its place names what it creates", () => {
    // A section adds a group, and a group adds a page. Two plus buttons on one
    // row carried no meaning, because their positions said nothing.
    const markup = renderList(navigation, "/")

    expect(markup).not.toContain('aria-label="New page in Documentation"')
    expect(markup).not.toContain('aria-label="New group in Introduction"')
  })

  test("makes each whole row the drag source, with no separate handle", () => {
    const markup = renderList(navigation, "/")
    const keys = 'aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"'

    expect(markup).toContain(`data-drag-row="section:docs" ${keys}`)
    expect(markup).toContain(`data-drag-row="group:docs:Introduction#0" ${keys}`)
    expect(markup).toContain(`data-drag-row="page:/" ${keys}`)
    expect(markup).not.toContain('aria-label="Drag the')
  })

  test("marks an open section with an open folder and a closed one with a folder", () => {
    const markup = renderList(navigation, "/")

    expect(markup).toContain("lucide-folder-open")
    expect(markup).toContain("lucide-folder ")
  })

  test("keeps the section row when one section holds every page so it can be edited", () => {
    const markup = renderList(
      [
        {
          slug: "docs",
          label: "Documentation",
          isDefault: true,
          groups: [
            { heading: "Introduction", groupIndex: 0, hrefs: ["/", "/guide"] },
            { heading: "Endpoints", groupIndex: 1, hrefs: ["/api"] },
          ],
        },
      ],
      "/",
    )

    expect(markup).toContain(">Documentation<")
    expect(markup).toContain('aria-label="Actions for the section Documentation"')
    expect(markup).toContain("Introduction")
    expect(markup).toContain("Overview")
  })

  test("renders pages directly for one unnamed group", () => {
    const markup = renderList(
      [
        {
          slug: "docs",
          label: "Documentation",
          isDefault: true,
          groups: [
            { heading: null, groupIndex: null, hrefs: ["/", "/guide", "/api"] },
          ],
        },
      ],
      "/",
    )

    expect(markup).toContain("Overview")
    expect(markup).toContain("Guide")
    expect(markup).toContain('aria-expanded="true"')
  })

  test("renders an unnamed group without a row beside named groups", () => {
    const markup = renderList(
      [
        {
          slug: "docs",
          label: "Documentation",
          isDefault: true,
          groups: [
            { heading: null, groupIndex: null, hrefs: ["/"] },
            { heading: "Introduction", groupIndex: 0, hrefs: ["/guide", "/api"] },
          ],
        },
      ],
      "/",
    )

    expect(countBlankToggles(markup)).toBe(0)
    expect(markup).toContain("Overview")
    expect(markup).toContain("Introduction")
  })

  test("shows a flat page list when the navigation places nothing", () => {
    const markup = renderList([], "/")

    expect(markup).not.toContain(">Other<")
    expect(markup).not.toContain('aria-expanded="')
    expect(markup).toContain("Overview")
    expect(markup).toContain("Guide")
    expect(markup).toContain("API")
  })
})

/**
 * Counts expand toggles that show no name.
 *
 * A row toggle carries `aria-controls` and takes its name from its text. The
 * actions menu also reports `aria-expanded`, so it is excluded by its label.
 */
function countBlankToggles(markup: string): number {
  const toggles = markup.match(/<button[^>]*aria-expanded[^>]*>.*?<\/button>/g) ?? []
  return toggles
    .filter((toggle) => toggle.includes("aria-controls") && !toggle.includes("aria-label"))
    .filter((toggle) => !toggle.replace(/<[^>]*>/g, "").trim()).length
}

function renderList(
  sections: readonly DocsContentNavigationSectionDto[],
  selectedHref: string,
  homeHref: string | null = null,
  homePending = false,
): string {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(ContentPageList, {
        projectId: "project-1",
        pages,
        navigation: sections,
        selectedHref,
        home: { href: homeHref, pending: homePending },
        onSelect: vi.fn(),
      }),
    ),
  )
}

function createPage(
  href: string,
  title: string,
  status: DocsContentPageDto["status"] = "published",
): DocsContentPageDto {
  return {
    href,
    title,
    status,
    sourcePath: `source${href === "/" ? "/index" : href}.mdx`,
    icon: null,
  }
}
