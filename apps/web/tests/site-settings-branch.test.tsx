// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, renderHook } from "@testing-library/react"
import type { NamedDocsBranch } from "@doxahq/contracts/docs-branches"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { opensSiteSettingsOnMain, useBranchContext } from "~/lib/dashboard/use-branch-context"
import { docsBranchQueryKeys } from "~/lib/queries/docs-branches"

const PROJECT = "p1"
const BRANCH = "10000000-0000-4000-8000-000000000001"
const STORAGE_KEY = `doxa:docs-branch:${PROJECT}`
const OVERVIEW = `/dashboard/projects/${PROJECT}/project`
const CONTENT = `/dashboard/projects/${PROJECT}/content`
const APPEARANCE = `/dashboard/projects/${PROJECT}/site/appearance`
const DOMAINS = `/dashboard/projects/${PROJECT}/site/domains`

describe("opensSiteSettingsOnMain", () => {
  test("site settings opened from a page other than the editor use main", () => {
    expect(opensSiteSettingsOnMain(OVERVIEW, APPEARANCE)).toBe(true)
    expect(opensSiteSettingsOnMain(`/dashboard/projects/${PROJECT}/generations`, DOMAINS)).toBe(true)
  })

  test("a page load on site settings uses main", () => {
    expect(opensSiteSettingsOnMain(null, APPEARANCE)).toBe(true)
  })

  test("site settings opened from the content editor keep the branch", () => {
    expect(opensSiteSettingsOnMain(CONTENT, APPEARANCE)).toBe(false)
  })

  test("moving between site settings sections keeps the branch", () => {
    expect(opensSiteSettingsOnMain(APPEARANCE, DOMAINS)).toBe(false)
  })

  test("other pages never change the branch", () => {
    expect(opensSiteSettingsOnMain(APPEARANCE, CONTENT)).toBe(false)
    expect(opensSiteSettingsOnMain(OVERVIEW, CONTENT)).toBe(false)
  })
})

describe("useBranchContext on site settings", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage())
    localStorage.setItem(STORAGE_KEY, BRANCH)
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  function renderBranch(initialPathname: string) {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } } })
    client.setQueryData(docsBranchQueryKeys.list(PROJECT), { branches: [namedBranch()], maxBranchesPerSite: 5 })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const refs: string[] = []
    const view = renderHook(
      ({ pathname }: { pathname: string }) => {
        const branch = useBranchContext(PROJECT, pathname)
        refs.push(branch.branchRef)
        return branch
      },
      { wrapper, initialProps: { pathname: initialPathname } },
    )
    return { view, refs }
  }

  test("from the overview, site settings render main from their first frame and store it", () => {
    const { view, refs } = renderBranch(OVERVIEW)
    expect(view.result.current.branchRef).toBe(BRANCH)

    refs.length = 0
    view.rerender({ pathname: APPEARANCE })

    expect(refs).not.toContain(BRANCH)
    expect(view.result.current.branchRef).toBe("main")
    expect(localStorage.getItem(STORAGE_KEY)).toBe("main")
  })

  test("from the content editor, site settings keep the selected branch", () => {
    const { view } = renderBranch(CONTENT)
    view.rerender({ pathname: APPEARANCE })

    expect(view.result.current.branchRef).toBe(BRANCH)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(BRANCH)
  })

  test("a page load on site settings starts on main", () => {
    const { view, refs } = renderBranch(APPEARANCE)

    expect(refs).not.toContain(BRANCH)
    expect(view.result.current.branchRef).toBe("main")
  })
})

function namedBranch(): NamedDocsBranch {
  return {
    id: BRANCH,
    kind: "named",
    name: "generation-review",
    purpose: "user",
    baseVersionId: "20000000-0000-4000-8000-000000000001",
    createdFromBranchId: null,
    createdBy: { kind: "user" },
    revision: 1,
    changeCount: 2,
    createdAt: "2026-09-24T10:00:00.000Z",
    updatedAt: "2026-09-24T11:00:00.000Z",
  }
}

function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  }
}
