// @vitest-environment jsdom
import type { ReactNode } from "react"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { DocsContentEdit, DocsContentPageDetailDto } from "@doxahq/contracts"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

/**
 * A small content server: one default section, page bodies by href, and the
 * rename and save edits the editor sends. Every page read is recorded.
 */
const server = vi.hoisted(() => {
  const state = {
    pages: [] as { href: string; title: string; edited: boolean; icon?: string | null }[],
    failNext: false,
    bodies: new Map<string, string>(),
    pageReads: [] as string[],
    /** The default page in the published site config, or null for none. */
    homePage: null as string | null,
    /** How long the overview request takes. */
    overviewDelayMs: 5,
    /** The start and end of each request, in order. */
    events: [] as string[],
  }
  const delay = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

  function reset() {
    state.pages = [
      { href: "/", title: "Home", edited: false },
      { href: "/guide", title: "Guide", edited: false },
    ]
    state.bodies = new Map([
      ["/", "---\ntitle: Home\n---\n\nHome body.\n"],
      ["/guide", "---\ntitle: Guide\n---\n\nGuide body.\n"],
    ])
    state.pageReads = []
    state.failNext = false
    state.homePage = null
    state.overviewDelayMs = 5
    state.events = []
  }

  function overview() {
    return {
      projectId: "p1",
      projectSlug: "example",
      siteId: "s1",
      working: { branchId: null, editedHrefs: state.pages.filter((page) => page.edited).map((page) => page.href) },
      pages: state.pages.map((page) => ({
        href: page.href,
        title: page.title,
        sourcePath: `source${page.href === "/" ? "" : page.href}/index.mdx`,
        status: page.edited ? "edited" : "published",
        icon: page.icon ?? null,
      })),
      navigation: [
        {
          slug: "docs",
          label: "Docs",
          isDefault: true,
          groups: [{ heading: null, groupIndex: null, hrefs: state.pages.map((page) => page.href) }],
        },
      ],
      siteConfig: { published: state.homePage ? { homePage: state.homePage } : {}, working: null },
    }
  }

  function apply(edit: { type: string; href?: string | null; slug?: string; content?: string; icon?: string | null }) {
    if (state.failNext) {
      state.failNext = false
      throw new Error("The server refused the edit.")
    }
    const page = state.pages.find((candidate) => candidate.href === edit.href)
    if (!page) throw new Error(`No page exists at ${edit.href}.`)
    if (edit.type === "set_page_content") {
      state.bodies.set(page.href, edit.content ?? "")
      page.edited = true
      return
    }
    if (edit.type === "set_page_icon") {
      page.icon = edit.icon ?? null
      return
    }
    if (edit.type === "rename_page") {
      const to = `/${edit.slug}`
      if (state.pages.some((candidate) => candidate.href === to)) throw new Error(`A page already exists at ${to}.`)
      state.bodies.set(to, state.bodies.get(page.href) ?? "")
      state.bodies.delete(page.href)
      page.href = to
      page.edited = true
    }
  }

  /** Pages whose body uses the unknown <Bogus> component, as the MDX check reports them. */
  function mdxIssues(hrefs: readonly string[]) {
    return hrefs.flatMap((href) => {
      const lines = (state.bodies.get(href) ?? "").split("\n")
      const line = lines.findIndex((text) => text.includes("<Bogus"))
      if (line < 0) return []
      const sourcePath = `source${href === "/" ? "" : href}/index.mdx`
      return [{ href, sourcePath, issues: [{ line: line + 1, column: 1, message: "Unknown MDX component: Bogus" }] }]
    })
  }

  return { state, delay, reset, overview, apply, mdxIssues }
})

vi.mock("~/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/platform-api")>()),
  getProjectContent: async () => {
    server.state.events.push("overview:start")
    await server.delay(server.state.overviewDelayMs)
    server.state.events.push("overview:end")
    return server.overview()
  },
  getProjectContentPage: async (_projectId: string, href: string) => {
    server.state.pageReads.push(href)
    server.state.events.push(`page:start:${href}`)
    await server.delay()
    const body = server.state.bodies.get(href)
    if (body === undefined) throw new Error(`No page exists at ${href}.`)
    const page = server.state.pages.find((candidate) => candidate.href === href)
    return {
      href,
      title: page?.title ?? "",
      sourcePath: "",
      status: page?.edited ? "edited" : "published",
      publishedContent: body,
      workingContent: page?.edited ? body : null,
    } satisfies DocsContentPageDetailDto
  },
  applyProjectContentEdits: async (_projectId: string, input: { edits: DocsContentEdit[] }) => {
    await server.delay()
    for (const edit of input.edits) server.apply(edit)
    const saved = input.edits.flatMap((edit) => (edit.type === "set_page_content" ? [edit.href] : []))
    return { mdxIssues: server.mdxIssues(saved) }
  },
  getProjectContentMdxReport: async () => {
    await server.delay()
    return { pages: server.mdxIssues(server.state.pages.filter((page) => page.edited).map((page) => page.href)) }
  },
}))

const { useProjectContent } = await import("~/lib/dashboard/use-project-content")

interface Frame {
  href: string | null
  highlightedHref: string | null
  editorKey: string
  isLoading: boolean
  isPageLoading: boolean
  text: string
  error: string | null
}

let frames: Frame[] = []

function renderContent(requestedHref: string | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook(
    () => {
      const state = useProjectContent("p1", "main", { requestedHref })
      frames.push({
        href: state.selectedHref,
        highlightedHref: state.highlightedHref,
        editorKey: state.editorKey,
        isLoading: state.isLoading,
        isPageLoading: state.isPageLoading,
        text: state.text,
        error: state.error,
      })
      return state
    },
    { wrapper },
  )
}

async function openGuide(hook: ReturnType<typeof renderContent>) {
  await waitFor(() => expect(hook.result.current.text).toContain("Home body."))
  await act(() => hook.result.current.selectPage("/guide"))
  await waitFor(() => expect(hook.result.current.text).toContain("Guide body."))
}

/** Renames the open page and returns every render from the start of the rename. */
async function renameOpenPage(hook: ReturnType<typeof renderContent>, slug: string): Promise<Frame[]> {
  const from = frames.length
  const href = hook.result.current.selectedHref ?? ""
  await act(() => hook.result.current.structure.renamePage(href, "Guide", slug))
  await waitFor(() =>
    expect(hook.result.current.overview?.pages.map((page) => page.href)).toContain(`/${slug}`),
  )
  // Let the background refetch of the renamed page settle.
  await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
  return frames.slice(from)
}

beforeEach(() => {
  server.reset()
  frames = []
})

afterEach(cleanup)

describe("opening the editor", () => {
  test("opens the first page when no default page is chosen", async () => {
    const hook = renderContent()
    await waitFor(() => expect(hook.result.current.text).toContain("Home body."))
    expect(frames.find((frame) => frame.href !== null)?.href).toBe("/")
  })

  test("opens the default page, with no stop at the first page", async () => {
    server.state.homePage = "/guide"
    const hook = renderContent()
    await waitFor(() => expect(hook.result.current.text).toContain("Guide body."))
    expect(new Set(frames.map((frame) => frame.href))).toEqual(new Set([null, "/guide"]))
    expect(server.state.pageReads).toEqual(["/guide"])
  })
})

describe("opening the page from the URL", () => {
  test("opens the requested page, even when another page is the default", async () => {
    server.state.homePage = "/"
    const hook = renderContent("/guide")
    await waitFor(() => expect(hook.result.current.text).toContain("Guide body."))
    expect(server.state.pageReads).toEqual(["/guide"])
  })

  test("falls back to the default page when the requested page does not exist", async () => {
    server.state.homePage = "/guide"
    const hook = renderContent("/deleted")
    await waitFor(() => expect(hook.result.current.text).toContain("Guide body."))
    expect(hook.result.current.selectedHref).toBe("/guide")
  })

  test("the requested page loads in parallel with the overview, not after it", async () => {
    server.state.overviewDelayMs = 30
    const hook = renderContent("/guide")
    await waitFor(() => expect(hook.result.current.text).toContain("Guide body."))
    const pageStart = server.state.events.indexOf("page:start:/guide")
    expect(pageStart).toBeGreaterThanOrEqual(0)
    expect(pageStart).toBeLessThan(server.state.events.indexOf("overview:end"))
    expect(server.state.pageReads).toEqual(["/guide"])
    // The page opened once, with no switch on the way.
    expect(new Set(frames.map((frame) => frame.href))).toEqual(new Set(["/guide"]))
    expect(new Set(frames.map((frame) => frame.editorKey))).toEqual(new Set(["main:0"]))
  })

  test("a stale link shows no error and no empty page before the default page", async () => {
    server.state.homePage = "/guide"
    // The failed page read answers before the overview does.
    server.state.overviewDelayMs = 30
    const hook = renderContent("/deleted")
    await waitFor(() => expect(hook.result.current.text).toContain("Guide body."))

    expect(server.state.pageReads).toEqual(["/deleted", "/guide"])
    expect(frames.every((frame) => frame.error === null)).toBe(true)
    // Every frame that would show the page body shows the default page.
    const shown = frames.filter((frame) => !frame.isLoading && !frame.isPageLoading)
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.every((frame) => frame.href === "/guide" && frame.text.includes("Guide body."))).toBe(true)
  })

  test("a stale link whose read answers after the overview also falls back cleanly", async () => {
    server.state.homePage = "/guide"
    server.state.overviewDelayMs = 0
    const hook = renderContent("/deleted")
    await waitFor(() => expect(hook.result.current.text).toContain("Guide body."))

    expect(frames.every((frame) => frame.error === null)).toBe(true)
    const shown = frames.filter((frame) => !frame.isLoading && !frame.isPageLoading)
    expect(shown.every((frame) => frame.href === "/guide")).toBe(true)
  })

  test("a later page choice wins over the request", async () => {
    const hook = renderContent("/guide")
    await waitFor(() => expect(hook.result.current.text).toContain("Guide body."))
    await act(() => hook.result.current.selectPage("/"))
    await waitFor(() => expect(hook.result.current.text).toContain("Home body."))
    expect(hook.result.current.selectedHref).toBe("/")
  })
})

describe("renaming the open page", () => {
  test("keeps the page open at its new href, with no reload, jump or error", async () => {
    const hook = renderContent()
    await openGuide(hook)
    const editorKey = hook.result.current.editorKey
    server.state.pageReads = []

    const during = await renameOpenPage(hook, "setup")

    expect(hook.result.current.selectedHref).toBe("/setup")
    expect(during.every((frame) => frame.href === "/guide" || frame.href === "/setup")).toBe(true)
    expect(during.every((frame) => frame.editorKey === editorKey)).toBe(true)
    expect(during.some((frame) => frame.isPageLoading)).toBe(false)
    expect(during.every((frame) => frame.text.includes("Guide body."))).toBe(true)
    expect(during.map((frame) => frame.error).filter(Boolean)).toEqual([])
    expect(server.state.pageReads).not.toContain("/guide")
  })

  test("a second rename before a publish works the same way", async () => {
    const hook = renderContent()
    await openGuide(hook)
    const editorKey = hook.result.current.editorKey
    await renameOpenPage(hook, "setup")
    server.state.pageReads = []

    const during = await renameOpenPage(hook, "install")

    expect(hook.result.current.selectedHref).toBe("/install")
    expect(during.every((frame) => frame.href === "/setup" || frame.href === "/install")).toBe(true)
    expect(during.every((frame) => frame.editorKey === editorKey)).toBe(true)
    expect(during.some((frame) => frame.isPageLoading)).toBe(false)
    expect(during.map((frame) => frame.error).filter(Boolean)).toEqual([])
    expect(server.state.pageReads).not.toContain("/setup")
    expect(hook.result.current.pages.map((page) => page.href)).toEqual(["/", "/install"])
  })

  test("renaming back to an earlier slug opens the page with its body", async () => {
    const hook = renderContent()
    await openGuide(hook)
    await renameOpenPage(hook, "setup")
    await renameOpenPage(hook, "guide")

    expect(hook.result.current.selectedHref).toBe("/guide")
    expect(hook.result.current.text).toContain("Guide body.")
    expect(hook.result.current.error).toBeNull()
  })

  test("unsaved text is saved first and stays in the editor", async () => {
    const hook = renderContent()
    await openGuide(hook)
    act(() => hook.result.current.setText("---\ntitle: Guide\n---\n\nTyped before the rename.\n"))

    const during = await renameOpenPage(hook, "setup")

    expect(server.state.bodies.get("/setup")).toContain("Typed before the rename.")
    expect(during.at(-1)?.text).toContain("Typed before the rename.")
    expect(hook.result.current.isDirty).toBe(false)
  })

  test("a refused rename keeps the page where it was and leaves the page alert empty", async () => {
    const hook = renderContent()
    await openGuide(hook)
    const editorKey = hook.result.current.editorKey

    await act(async () => {
      await expect(hook.result.current.structure.renamePage("/guide", "Guide", "")).rejects.toThrow()
    })

    expect(hook.result.current.selectedHref).toBe("/guide")
    expect(hook.result.current.editorKey).toBe(editorKey)
    expect(hook.result.current.error).toBeNull()
  })

  test("opening another page still gives the editor a new key", async () => {
    const hook = renderContent()
    await openGuide(hook)
    const editorKey = hook.result.current.editorKey

    await act(() => hook.result.current.selectPage("/"))

    expect(hook.result.current.editorKey).not.toBe(editorKey)
  })
})

describe("clicking a page in the sidebar", () => {
  test("the clicked row is marked at once, before the editor switches", async () => {
    const hook = renderContent()
    await waitFor(() => expect(hook.result.current.text).toContain("Home body."))
    const from = frames.length

    await act(() => hook.result.current.selectPage("/guide"))
    await waitFor(() => expect(hook.result.current.text).toContain("Guide body."))

    const during = frames.slice(from)
    // A frame marks the clicked row while the old page is still open.
    expect(during.some((frame) => frame.highlightedHref === "/guide" && frame.href === "/")).toBe(true)
    // No frame marks the old row once the new page is open.
    expect(during.some((frame) => frame.href === "/guide" && frame.highlightedHref !== "/guide")).toBe(false)
    expect(hook.result.current.highlightedHref).toBe("/guide")
  })

  test("a refused save keeps the open page and moves the mark back", async () => {
    const hook = renderContent()
    await waitFor(() => expect(hook.result.current.text).toContain("Home body."))
    act(() => hook.result.current.setText("---\ntitle: Home\n---\n\nUnsaved.\n"))
    server.state.failNext = true

    await act(() => hook.result.current.selectPage("/guide"))

    expect(hook.result.current.selectedHref).toBe("/")
    expect(hook.result.current.highlightedHref).toBe("/")
    expect(hook.result.current.text).toContain("Unsaved.")
  })
})

describe("setting the open page icon", () => {
  test("the page list shows the icon before the server answers, and keeps it after", async () => {
    const hook = renderContent()
    await openGuide(hook)
    let saving: Promise<void> = Promise.resolve()
    act(() => {
      saving = hook.result.current.structure.setPageIcon("/guide", "rocket")
    })
    expect(hook.result.current.pages.find((page) => page.href === "/guide")?.icon).toBe("rocket")
    await act(() => saving)
    await waitFor(() => expect(server.state.pages.find((page) => page.href === "/guide")?.icon).toBe("rocket"))
    expect(hook.result.current.pages.find((page) => page.href === "/guide")?.icon).toBe("rocket")
  })

  test("a refused icon goes back to the previous one", async () => {
    const hook = renderContent()
    await openGuide(hook)
    server.state.failNext = true
    await act(async () => {
      await expect(hook.result.current.structure.setPageIcon("/guide", "rocket")).rejects.toThrow()
    })
    expect(hook.result.current.pages.find((page) => page.href === "/guide")?.icon).toBeNull()
  })
})

describe("MDX issues of a save (v2 spec 8.1)", () => {
  test("a save with invalid MDX stands and shows the issue of the open page", async () => {
    const hook = renderContent()
    await openGuide(hook)
    expect(hook.result.current.pageMdxIssues).toEqual([])

    act(() => hook.result.current.setText("---\ntitle: Guide\n---\n\n<Bogus>Hi</Bogus>\n"))
    await act(async () => {
      expect(await hook.result.current.saveBuffer()).toBe(true)
    })

    expect(server.state.bodies.get("/guide")).toContain("<Bogus>")
    await waitFor(() =>
      expect(hook.result.current.pageMdxIssues).toEqual([
        { line: 5, column: 1, message: "Unknown MDX component: Bogus" },
      ]),
    )
    expect(hook.result.current.mdxIssuePages.map((page) => page.href)).toEqual(["/guide"])
    expect(hook.result.current.error).toBeNull()

    act(() => hook.result.current.setText("---\ntitle: Guide\n---\n\nFixed.\n"))
    await act(async () => {
      await hook.result.current.saveBuffer()
    })
    await waitFor(() => expect(hook.result.current.mdxIssuePages).toEqual([]))
    expect(hook.result.current.pageMdxIssues).toEqual([])
  })
})
