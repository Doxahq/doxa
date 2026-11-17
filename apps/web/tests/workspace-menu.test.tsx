// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { ProjectDto } from "@doxahq/contracts"
import type { TeamSummary } from "@doxahq/contracts/teams"

const api = vi.hoisted(() => ({ listProjects: vi.fn(), listTeams: vi.fn(), listBillingAccounts: vi.fn() }))
vi.mock("~/lib/platform-api", async (importOriginal) => ({ ...(await importOriginal<object>()), listProjects: api.listProjects }))
vi.mock("~/lib/teams-api", async (importOriginal) => ({ ...(await importOriginal<object>()), listTeams: api.listTeams }))
vi.mock("~/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listBillingAccounts: api.listBillingAccounts,
}))
vi.mock("~/lib/auth/dashboard-auth-context", () => ({
  useDashboardAuth: () => ({ user: { id: "user-1", name: "Sam Lee", email: "sam@acme.dev", image: null }, isPending: false }),
}))

import { WorkspaceMenu } from "~/components/dashboard/shell/workspace-menu"
import { SidebarProvider } from "~/components/ui/sidebar"
import { useWorkspace, WorkspaceProvider } from "~/lib/dashboard/workspace-context"
import { newQueryClient } from "./fixtures/render-in-router"

const CODER_ONE = { id: "11111111-1111-4111-8111-111111111111", name: "Coder One" }

function project(id: string, team: ProjectDto["team"]): ProjectDto {
  return { id, name: id, slug: id, githubRepositoryId: null, repositoryFullName: null, publishedVersionId: null, docsUrl: null, team }
}

const TEAM: TeamSummary = { ...CODER_ONE, role: "admin", memberCount: 4, projectCount: 1, createdAt: "2026-11-01T00:00:00.000Z" }

function CurrentWorkspace() {
  const { current, crumb } = useWorkspace()
  return (
    <p>
      <span data-testid="current">{current?.name ?? "unknown"}</span>
      <span data-testid="crumb">{crumb ?? "none"}</span>
    </p>
  )
}

function renderShell(path: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        <WorkspaceProvider>
          <WorkspaceMenu />
          <CurrentWorkspace />
          <Outlet />
        </WorkspaceProvider>
      </SidebarProvider>
    ),
  })
  const anyPath = createRoute({ getParentRoute: () => rootRoute, path: "$", component: () => null })
  const router = createRouter({
    routeTree: rootRoute.addChildren([anyPath]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  render(
    <QueryClientProvider client={newQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

async function openMenu() {
  await userEvent.click(await screen.findByRole("button", { name: "Workspace menu" }))
  return screen.findByRole("menu")
}

/** This runtime has no working `localStorage`; the workspace choice needs one. */
function memoryStorage(): Storage {
  const entries = new Map<string, string>()
  return {
    get length() {
      return entries.size
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => void entries.delete(key),
    setItem: (key, value) => void entries.set(key, String(value)),
  }
}

/** The sidebar asks whether the window is narrow. */
function desktopMedia(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage())
  vi.stubGlobal("matchMedia", desktopMedia)
  vi.clearAllMocks()
  api.listProjects.mockResolvedValue([project("notes", null), project("payments", CODER_ONE)])
  api.listTeams.mockResolvedValue([TEAM])
  api.listBillingAccounts.mockResolvedValue({
    enforcement: "on",
    accounts: [
      { id: "acct-me", ownerKind: "user", ownerId: "user-1", name: null, plan: "free", canManage: true },
      { id: "acct-co", ownerKind: "team", ownerId: CODER_ONE.id, name: "Coder One", plan: "pro", canManage: true },
    ],
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("the workspace menu", () => {
  test("a project page shows its project's workspace, first in the breadcrumb", async () => {
    renderShell("/dashboard/projects/payments/project")
    await waitFor(() => expect(screen.getByTestId("current").textContent).toBe("Coder One"))
    expect(screen.getByTestId("crumb").textContent).toBe("Coder One")
  })

  test("lists Personal and the teams with their plan as text, then the current workspace's actions", async () => {
    renderShell("/dashboard/projects/payments/project")
    await waitFor(() => expect(screen.getByTestId("current").textContent).toBe("Coder One"))
    const menu = await openMenu()
    const options = within(menu).getAllByRole("menuitemradio")
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("Personal"),
      expect.stringContaining("Coder One"),
    ])
    expect(options[1].getAttribute("aria-checked")).toBe("true")
    await waitFor(() => expect(within(options[1]).getByText("Pro · 4 members · 1 project")).toBeTruthy())
    expect(within(menu).getByRole("menuitem", { name: "Create team" }).getAttribute("href")).toBe("/dashboard/teams")
    expect(within(menu).getByRole("menuitem", { name: "New project" }).getAttribute("href")).toBe("/dashboard/projects/new")
    expect(within(menu).getByRole("menuitem", { name: "Invite members" }).getAttribute("href")).toBe(
      `/dashboard/teams/${CODER_ONE.id}#invites`,
    )
    expect(within(menu).getByRole("menuitem", { name: "Billing" }).getAttribute("href")).toBe("/dashboard/billing/acct-co")
  })

  test("a switch from a project page lands on the new workspace's project and keeps the choice", async () => {
    const router = renderShell("/dashboard/projects/payments/project")
    await waitFor(() => expect(screen.getByTestId("current").textContent).toBe("Coder One"))
    const menu = await openMenu()
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: /Personal/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe("/dashboard/projects/notes/project"))
    expect(screen.getByTestId("current").textContent).toBe("Personal")
    expect(localStorage.getItem("doxa:workspace")).toBe("personal")
    expect(screen.queryByRole("menu")).toBeNull()
  })

  test("a click on the current workspace closes the menu and leaves the logo unfocused, with no label", async () => {
    renderShell("/dashboard/projects/payments/project")
    await waitFor(() => expect(screen.getByTestId("current").textContent).toBe("Coder One"))
    const menu = await openMenu()
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: /Coder One/ }))
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Workspace menu" }))
    expect(screen.queryByRole("tooltip")).toBeNull()
  })

  test("Escape gives the focus back to the logo, with no label", async () => {
    renderShell("/dashboard/projects/payments/project")
    await waitFor(() => expect(screen.getByTestId("current").textContent).toBe("Coder One"))
    const logo = await screen.findByRole("button", { name: "Workspace menu" })
    logo.focus()
    await userEvent.keyboard("{Enter}")
    await screen.findByRole("menu")
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(logo))
    expect(screen.queryByRole("tooltip")).toBeNull()
  })

  test("on New project the page stays and only the workspace changes", async () => {
    localStorage.setItem("doxa:workspace", "personal")
    const router = renderShell("/dashboard/projects/new")
    await waitFor(() => expect(screen.getByTestId("current").textContent).toBe("Personal"))
    const menu = await openMenu()
    expect(within(menu).queryByRole("menuitem", { name: "Invite members" })).toBeNull()
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: /Coder One/ }))
    await waitFor(() => expect(screen.getByTestId("current").textContent).toBe("Coder One"))
    expect(router.state.location.pathname).toBe("/dashboard/projects/new")
  })

  test("a team viewer sees Members, not New project, Invite members or Billing", async () => {
    api.listTeams.mockResolvedValue([{ ...TEAM, role: "viewer" }])
    renderShell("/dashboard/projects/payments/project")
    await waitFor(() => expect(screen.getByTestId("current").textContent).toBe("Coder One"))
    const menu = await openMenu()
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: "Members" })).toBeTruthy())
    for (const name of ["New project", "Invite members", "Billing"]) {
      expect(within(menu).queryByRole("menuitem", { name })).toBeNull()
    }
  })
})
