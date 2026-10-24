// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react"
import { CAPABILITIES, ROLE_CAPABILITIES, TEAM_ROLES, type TeamRole } from "@doxahq/contracts/teams"
import { afterEach, describe, expect, test, vi } from "vitest"

import { EditorTopBar } from "~/components/dashboard/content/editor-top-bar"
import { projectCapabilities, useProjectCapabilities } from "~/lib/dashboard/use-project-capabilities"

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
}))

vi.mock("~/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/platform-api")>()),
  getProject: mocks.getProject,
}))

// The top bar's shell pieces need the dashboard providers; the test keeps
// only what decides which actions show.
vi.mock("~/lib/dashboard/shell-context", () => ({
  useShell: () => ({ toggleFocusMode: () => undefined }),
  isEditableTarget: () => false,
}))
vi.mock("~/components/dashboard/shell/top-bar", () => ({
  TopBar: ({ actions, menu }: { actions: ReactNode; menu: ReactNode }) => (
    <div>
      {actions}
      {menu}
    </div>
  ),
  MoreMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MoreMenuLabel: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  SiteMenuItems: () => null,
}))
vi.mock("~/components/ui/dropdown-menu", () => ({
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div role="menuitem">{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}))
vi.mock("~/components/dashboard/content/branches/publish-menu", () => ({
  PublishMenu: () => <button type="button">Publish</button>,
}))

afterEach(() => {
  cleanup()
  mocks.getProject.mockReset()
})

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe("projectCapabilities", () => {
  test.each(TEAM_ROLES)("follows the shared role table for %s", (role) => {
    const { can } = projectCapabilities(role)
    for (const capability of CAPABILITIES) {
      expect(can(capability)).toBe(ROLE_CAPABILITIES[role].has(capability))
    }
  })

  test("allows nothing while the role is unknown", () => {
    const { can } = projectCapabilities(null)
    expect(CAPABILITIES.some((capability) => can(capability))).toBe(false)
  })
})

describe("useProjectCapabilities", () => {
  test("reads the viewer's role from the project query", async () => {
    mocks.getProject.mockResolvedValue({ role: "editor" })
    const hook = renderHook(() => useProjectCapabilities("project-1"), { wrapper })

    expect(hook.result.current.role).toBeNull()
    expect(hook.result.current.can("docs.write")).toBe(false)
    await waitFor(() => expect(hook.result.current.role).toBe("editor"))
    expect(hook.result.current.can("docs.write")).toBe(true)
    expect(hook.result.current.can("domains.write")).toBe(false)
    expect(mocks.getProject).toHaveBeenCalledWith("project-1")
  })
})

describe("editor top bar by role", () => {
  test("a viewer sees no Publish and no write actions", () => {
    renderTopBar("viewer")
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull()
    expect(screen.queryByText(/Discard all changes/)).toBeNull()
    expect(screen.queryByText("Revert page to published")).toBeNull()
    expect(screen.queryByText("Set as default page")).toBeNull()
    expect(screen.queryByText("Preview URL")).toBeNull()
    // Reading stays: the live page link.
    expect(screen.getByText("Open page on live site")).toBeTruthy()
  })

  test("an owner keeps Publish and every write action", () => {
    renderTopBar("owner")
    expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy()
    expect(screen.getByText("Discard all changes on main")).toBeTruthy()
    expect(screen.getByText("Revert page to published")).toBeTruthy()
    expect(screen.getByText("Set as default page")).toBeTruthy()
    expect(screen.getByText("Preview URL")).toBeTruthy()
  })
})

type TopBarProps = ComponentProps<typeof EditorTopBar>

function renderTopBar(role: TeamRole) {
  mocks.getProject.mockResolvedValue({ role, project: { publishedVersionId: null, docsUrl: null } })
  const props = {
    projectId: "project-1",
    capabilities: projectCapabilities(role),
    state: contentState(),
    tree: [],
    branch: "main",
    namedBranch: null,
    branchName: "main",
    status: null,
    changeCount: 1,
    preview: { canBuild: true, url: null },
    publishMenu: { open: false, view: "review" },
    approvalRequest: null,
    onPublishMenuOpenChange: () => undefined,
    onPublishMenuViewChange: () => undefined,
    onOpenPreview: () => undefined,
    onSynchronize: () => undefined,
    onBranchErased: () => undefined,
    onOpenDiscard: () => undefined,
    onOpenPageDiff: () => undefined,
  }
  // The test fills only the fields the top bar reads.
  render(<EditorTopBar {...(props as unknown as TopBarProps)} />, { wrapper })
}

function contentState() {
  return {
    viewMode: "write",
    setViewMode: () => undefined,
    isSaving: false,
    isDirty: false,
    selectedHref: "/",
    page: { title: "Home", status: "edited" },
    resetPage: async () => undefined,
    hasChanges: true,
    isDiscarding: false,
    overview: null,
    pages: [],
    navigation: [],
    structure: { setHomePage: async () => undefined },
  }
}
