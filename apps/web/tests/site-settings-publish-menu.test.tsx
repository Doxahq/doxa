// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import type { DocsContentOverviewDto } from "@doxahq/contracts"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { PublishMenuProps } from "~/components/dashboard/content/branches/publish-menu"
import { SiteSettingsPublishMenu } from "~/components/dashboard/site-settings/site-settings-publish-menu"
import type { SiteSettingsState } from "~/lib/dashboard/use-site-settings"
import { generationReviewQueryKeys } from "~/lib/queries/generation-review"

const mocks = vi.hoisted(() => ({
  menu: null as PublishMenuProps | null,
  syncOpen: false,
  onSynchronized: null as (() => void) | null,
  navigate: vi.fn(async () => undefined),
  selectBranch: vi.fn(),
  branchRef: "main",
  selectedBranch: null as { id: string; name: string } | null,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }))
vi.mock("~/components/dashboard/content/branches/publish-menu", () => ({
  PublishMenu: (props: PublishMenuProps) => {
    mocks.menu = props
    return <div data-testid="publish-menu" />
  },
}))
vi.mock("~/components/dashboard/content/branches/sync-dialog", () => ({
  SyncDialog: (props: { open: boolean; onSynchronized: () => void }) => {
    mocks.syncOpen = props.open
    mocks.onSynchronized = props.onSynchronized
    return null
  },
}))
vi.mock("~/components/dashboard/shell/site-settings-sidebar-view", () => ({
  hostOf: () => "acme.doxa.page",
}))
vi.mock("~/lib/dashboard/project-branch-context", () => ({
  useProjectBranch: () => ({
    branchRef: mocks.branchRef,
    selectedBranch: mocks.selectedBranch,
    selectBranch: mocks.selectBranch,
  }),
}))
vi.mock("~/lib/dashboard/use-branch-status", () => ({
  useBranchStatus: () => ({ data: null }),
}))
vi.mock("~/lib/dashboard/use-branch-preview", () => ({
  useBranchPreview: () => ({}),
}))

const overview = {
  projectSlug: "acme",
  pages: [],
  working: { changeCount: 0, baseVersionId: "base", revision: 1 },
} as unknown as DocsContentOverviewDto

beforeEach(() => {
  mocks.menu = null
  mocks.syncOpen = false
  mocks.branchRef = "main"
  mocks.selectedBranch = null
  vi.clearAllMocks()
  // The queries wait. Each test seeds the data that it needs.
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("site settings publish menu", () => {
  test("settings with errors keep the menu closed, and the save attempt shows them", () => {
    const state = settings({ errorCount: 2 })
    renderMenu(state)
    act(() => mocks.menu?.onOpenChange(true))
    expect(state.saveNow).toHaveBeenCalledOnce()
    expect(mocks.menu?.open).toBe(false)
  })

  test("opening saves the settings, and unsaved edits count as changes", async () => {
    const state = settings({ isDirty: true })
    renderMenu(state)
    expect(mocks.menu?.state.hasChanges).toBe(true)
    expect(mocks.menu?.state.isDirty).toBe(true)
    await act(async () => mocks.menu?.onOpenChange(true))
    expect(state.saveNow).toHaveBeenCalledOnce()
    expect(mocks.menu?.open).toBe(true)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  test("a failed save closes the menu and reports that nothing was published", async () => {
    renderMenu(settings({ saveNow: vi.fn(async () => false) }))
    await act(async () => mocks.menu?.onOpenChange(true))
    await waitFor(() => expect(mocks.menu?.open).toBe(false))
    expect(mocks.toastError).toHaveBeenCalledWith("The settings could not be saved. Nothing was published.")
  })

  test("a page with MDX issues opens in the editor", async () => {
    renderMenu(settings())
    await mocks.menu?.state.selectPage("/guide")
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/dashboard/projects/$projectId/content",
      params: { projectId: "project-1" },
      search: { page: "/guide" },
    })
  })

  test("an erased branch returns to main and confirms the publish in a toast", () => {
    renderMenu(settings())
    act(() => mocks.menu?.onBranchErased())
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Published to acme.doxa.page")
    expect(mocks.selectBranch).toHaveBeenCalledWith("main")
  })

  test("synchronize saves, opens the dialog, and reloads the settings after it", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    })
    const state = settings()
    renderMenu(state)
    await act(async () => mocks.menu?.onSynchronize())
    expect(state.saveNow).toHaveBeenCalledOnce()
    expect(mocks.syncOpen).toBe(true)
    act(() => mocks.onSynchronized?.())
    expect(state.reloadFromBranch).toHaveBeenCalledOnce()
  })

  test("main shows the menu before the review loads", () => {
    renderMenu(settings())
    expect(screen.getByTestId("publish-menu")).toBeTruthy()
  })

  test("a named branch waits for the review before it shows the menu", () => {
    mocks.branchRef = "branch-1"
    renderMenu(settings())
    expect(screen.queryByTestId("publish-menu")).toBeNull()
  })

  test("a review branch has no menu, because it publishes through its review", () => {
    mocks.branchRef = "branch-1"
    renderMenu(settings(), { branch: { id: "branch-1" } })
    expect(screen.queryByTestId("publish-menu")).toBeNull()
  })

  test("another named branch shows the menu while a review is open", () => {
    mocks.branchRef = "branch-2"
    mocks.selectedBranch = { id: "branch-2", name: "docs-update" }
    renderMenu(settings(), { branch: { id: "branch-1" } })
    expect(screen.getByTestId("publish-menu")).toBeTruthy()
    expect(mocks.menu?.branchName).toBe("docs-update")
  })
})

function settings(overrides: Partial<SiteSettingsState> = {}): SiteSettingsState {
  return {
    errorCount: 0,
    isDirty: false,
    isSaving: false,
    saveNow: vi.fn(async () => true),
    reloadFromBranch: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as SiteSettingsState
}

function renderMenu(state: SiteSettingsState, review?: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (review !== undefined) client.setQueryData(generationReviewQueryKeys.project("project-1"), review)
  render(
    <QueryClientProvider client={client}>
      <SiteSettingsPublishMenu projectId="project-1" overview={overview} state={state} />
    </QueryClientProvider>,
  )
}
