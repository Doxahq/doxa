// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  settled: false,
  view: "project" as "project" | "content" | "site",
  getProject: vi.fn(),
  getProjectContent: vi.fn(),
  listDocsDomains: vi.fn(),
  listApprovalRequests: vi.fn(),
}))

vi.mock("~/lib/dashboard/use-page-settled", () => ({ usePageSettled: () => mocks.settled }))
vi.mock("~/lib/dashboard/shell-context", () => ({
  useShell: () => ({ view: mocks.view, showView: () => undefined, closeSiteSettings: () => undefined }),
}))
vi.mock("~/lib/dashboard/project-branch-context", () => ({
  useOptionalProjectBranch: () => ({ branchRef: "main" }),
}))
vi.mock("~/lib/dashboard/use-rendered-pathname", () => ({
  useRenderedPathname: () => "/dashboard/projects/p1/project",
}))
vi.mock("~/components/dashboard/shell/sidebar-nav", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/dashboard/shell/sidebar-nav")>()),
  SidebarNavLink: ({ label, hint }: { label: string; hint?: ReactNode }) => (
    <div>
      {label}
      {hint}
    </div>
  ),
}))
vi.mock("~/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/platform-api")>()),
  getProject: mocks.getProject,
  getProjectContent: mocks.getProjectContent,
  listDocsDomains: mocks.listDocsDomains,
}))
vi.mock("~/lib/approval-requests-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/approval-requests-api")>()),
  listApprovalRequests: mocks.listApprovalRequests,
}))

const { ProjectSidebarView } = await import("~/components/dashboard/shell/project-sidebar-view")
const { SiteSettingsSidebarView } = await import("~/components/dashboard/shell/site-settings-sidebar-view")

beforeEach(() => {
  mocks.settled = false
  mocks.view = "project"
  mocks.getProject.mockResolvedValue({
    project: { id: "p1", name: "Flagforge", publishedVersionId: "v1", docsUrl: "https://flagforge.doxa.page" },
    latestJob: null,
    role: "owner",
  })
  mocks.getProjectContent.mockResolvedValue({
    working: { editedHrefs: ["/a", "/b"] },
    siteConfig: { published: null, working: null },
  })
  mocks.listDocsDomains.mockResolvedValue({ domains: [] })
  mocks.listApprovalRequests.mockResolvedValue({ requests: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderWith(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
  return {
    rerender: (next: ReactNode) => view.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>),
  }
}

describe("requests the first paint does not need", () => {
  test("the project view asks for the content overview only after the page settles", async () => {
    const view = renderWith(<ProjectSidebarView projectId="p1" />)
    await waitFor(() => expect(screen.getByText("Flagforge")).toBeTruthy())
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(mocks.getProjectContent).not.toHaveBeenCalled()
    expect(screen.queryByText(/edited/i)).toBeNull()

    mocks.settled = true
    view.rerender(<ProjectSidebarView projectId="p1" />)
    await waitFor(() => expect(mocks.getProjectContent).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText(/2 edited/i)).toBeTruthy())
  })

  test("the hidden site settings view waits for the page to settle", async () => {
    const view = renderWith(<SiteSettingsSidebarView projectId="p1" />)
    await waitFor(() => expect(mocks.getProject).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(mocks.getProjectContent).not.toHaveBeenCalled()
    expect(mocks.listDocsDomains).not.toHaveBeenCalled()

    mocks.settled = true
    view.rerender(<SiteSettingsSidebarView projectId="p1" />)
    await waitFor(() => expect(mocks.listDocsDomains).toHaveBeenCalledTimes(1))
    expect(mocks.getProjectContent).toHaveBeenCalledTimes(1)
  })

  test("the site settings view loads at once when it is the view on screen", async () => {
    mocks.view = "site"
    renderWith(<SiteSettingsSidebarView projectId="p1" />)
    await waitFor(() => expect(mocks.listDocsDomains).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mocks.getProjectContent).toHaveBeenCalledTimes(1))
  })
})
