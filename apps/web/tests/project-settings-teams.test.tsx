// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  getProjectGenerationCache: vi.fn(),
  getProjectDoxabotSettings: vi.fn(),
  listTeams: vi.fn(),
}))

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
}))
vi.mock("~/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/platform-api")>()),
  getProject: mocks.getProject,
  getProjectGenerationCache: mocks.getProjectGenerationCache,
  getProjectDoxabotSettings: mocks.getProjectDoxabotSettings,
}))
vi.mock("~/lib/teams-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/teams-api")>()),
  listTeams: mocks.listTeams,
}))
// The other cards have their own tests. This test is about the page's one loading state.
vi.mock("~/components/dashboard/project-doxabot-page", () => ({ DoxabotSettingsCard: () => null }))
vi.mock("~/components/dashboard/project-delete-card", () => ({ ProjectDeleteCard: () => null }))
vi.mock("~/components/dashboard/content/site-settings/fields/controls", () => ({
  Select: ({ options }: { options: { value: string; label: string }[] }) => (
    <select aria-label="Team">
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}))
vi.mock("~/components/dashboard/skeletons/settings-skeletons", () => ({
  ProjectSettingsSkeleton: () => <p>settings skeleton</p>,
}))

const { ProjectSettingsPage } = await import("~/components/dashboard/project-settings-page")

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function personalProject(role: string) {
  return { project: { id: "p1", name: "Flagforge", team: null }, latestJob: null, role }
}

beforeEach(() => {
  mocks.getProjectGenerationCache.mockResolvedValue({ clearedAt: null })
  mocks.getProjectDoxabotSettings.mockResolvedValue({})
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ProjectSettingsPage projectId="p1" />
    </QueryClientProvider>,
  )
}

describe("project settings: the Team card", () => {
  test("an owner's page waits for the teams, then shows them with no second loading state", async () => {
    mocks.getProject.mockResolvedValue(personalProject("owner"))
    const teams = deferred<unknown[]>()
    mocks.listTeams.mockReturnValue(teams.promise)
    renderPage()

    await waitFor(() => expect(mocks.listTeams).toHaveBeenCalledTimes(1))
    expect(screen.getByText("settings skeleton")).toBeTruthy()

    teams.resolve([{ id: "t1", name: "Core", role: "owner" }])
    await waitFor(() => expect(screen.getByRole("button", { name: "Move to team" })).toBeTruthy())
    expect(screen.queryByText("settings skeleton")).toBeNull()
    expect(screen.queryByText(/Loading your teams/)).toBeNull()
  })

  test("a role that cannot move the project does not ask for the teams", async () => {
    mocks.getProject.mockResolvedValue(personalProject("editor"))
    renderPage()

    await waitFor(() => expect(screen.getByText("Team")).toBeTruthy())
    expect(mocks.listTeams).not.toHaveBeenCalled()
  })

  test("a team project does not ask for the teams", async () => {
    mocks.getProject.mockResolvedValue({
      project: { id: "p1", name: "Flagforge", team: { id: "t1", name: "Core" } },
      latestJob: null,
      role: "owner",
    })
    renderPage()

    await waitFor(() => expect(screen.getByText(/Core shares this project/)).toBeTruthy())
    expect(mocks.listTeams).not.toHaveBeenCalled()
  })
})
