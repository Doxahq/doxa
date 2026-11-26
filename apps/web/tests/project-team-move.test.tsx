// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { FREE_ACCOUNTS_MOVE_KEY } from "@doxahq/billing/catalog"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  listTeams: vi.fn(),
  moveProjectToTeam: vi.fn(),
  listBillingAccounts: vi.fn(),
}))

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, params }: { children: ReactNode; params?: { accountId?: string } }) => (
    <a href={params?.accountId ? `/dashboard/billing/${params.accountId}` : "#"}>{children}</a>
  ),
}))
vi.mock("~/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/platform-api")>()),
  getProject: mocks.getProject,
}))
vi.mock("~/lib/teams-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/teams-api")>()),
  listTeams: mocks.listTeams,
  moveProjectToTeam: mocks.moveProjectToTeam,
}))
vi.mock("~/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/billing-api")>()),
  listBillingAccounts: mocks.listBillingAccounts,
}))
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

const { ProjectTeamCard } = await import("~/components/dashboard/project-team-card")
const { createApiError } = await import("~/lib/api-errors")
const { reportBillingDenial, showBillingDenial, useBillingDenial } = await import("~/lib/dashboard/billing-denials")
const { getQueryClient } = await import("~/lib/query-client")

const PERSONAL_ACCOUNT = "acct-personal"
const TEAM_ACCOUNT = "acct-team"
const MESSAGE = 'Moving a project between two Free workspaces is not possible. Upgrade "Core" to Pro first.'

function accounts(input: { personal: string; team: string; enforcement?: "off" | "shadow" | "on" }) {
  return {
    enforcement: input.enforcement ?? "on",
    accounts: [
      { id: PERSONAL_ACCOUNT, ownerKind: "user", ownerId: "u1", name: null, plan: input.personal, canManage: true },
      { id: TEAM_ACCOUNT, ownerKind: "team", ownerId: "t1", name: "Core", plan: input.team, canManage: true },
    ],
  }
}

function personalProject(plan: string) {
  return {
    project: { id: "p1", name: "Flagforge", team: null, ownerUserId: "u1" },
    latestJob: null,
    role: "owner",
    billing: { accountId: PERSONAL_ACCOUNT, plan, enforcement: "on" },
  }
}

function moveRefusal() {
  return createApiError(403, {
    error: {
      message: "Plan limit reached",
      details: {
        code: "plan_limit",
        key: FREE_ACCOUNTS_MOVE_KEY,
        limit: false,
        used: null,
        plan: "free",
        resetsAt: null,
        upgradeUrl: `https://doxa.test/dashboard/billing/${TEAM_ACCOUNT}`,
      },
    },
  })
}

/** Shows whether the dashboard's billing dialog has a denial to open. */
function DenialProbe() {
  const denial = useBillingDenial()
  return <p>{denial ? `global denial: ${denial.kind}` : "no global denial"}</p>
}

function renderCard() {
  // The app's client: its mutation cache reports billing denials to the global dialog.
  const client = getQueryClient()
  client.clear()
  return render(
    <QueryClientProvider client={client}>
      <ProjectTeamCard projectId="p1" />
      <DenialProbe />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mocks.listTeams.mockResolvedValue([{ id: "t1", name: "Core", role: "owner" }])
})

afterEach(() => {
  cleanup()
  showBillingDenial(null)
  vi.clearAllMocks()
})

describe("project settings: no move between two Free accounts", () => {
  test("both accounts on Free: the message shows above a disabled button, with the team's billing link", async () => {
    mocks.getProject.mockResolvedValue(personalProject("free"))
    mocks.listBillingAccounts.mockResolvedValue(accounts({ personal: "free", team: "free" }))
    renderCard()

    const notice = await screen.findByRole("alert")
    expect(notice.textContent).toContain(MESSAGE)
    expect(screen.getByRole("link", { name: "Upgrade" }).getAttribute("href")).toBe(`/dashboard/billing/${TEAM_ACCOUNT}`)
    expect(screen.getByRole("button", { name: "Move to team" }).hasAttribute("disabled")).toBe(true)
  })

  test("a Pro side: no message, and the button works", async () => {
    for (const plans of [
      { personal: "pro", team: "free" },
      { personal: "free", team: "pro" },
    ]) {
      mocks.getProject.mockResolvedValue(personalProject(plans.personal))
      mocks.listBillingAccounts.mockResolvedValue(accounts(plans))
      renderCard()
      const button = await screen.findByRole("button", { name: "Move to team" })
      await waitFor(() => expect(mocks.listBillingAccounts).toHaveBeenCalled())
      expect(button.hasAttribute("disabled")).toBe(false)
      expect(screen.queryByText(/two Free workspaces/)).toBeNull()
      cleanup()
    }
  })

  test("enforcement not on: no message before the click", async () => {
    mocks.getProject.mockResolvedValue(personalProject("free"))
    mocks.listBillingAccounts.mockResolvedValue(accounts({ personal: "free", team: "free", enforcement: "shadow" }))
    renderCard()
    const button = await screen.findByRole("button", { name: "Move to team" })
    await waitFor(() => expect(mocks.listBillingAccounts).toHaveBeenCalled())
    expect(button.hasAttribute("disabled")).toBe(false)
    expect(screen.queryByText(/two Free workspaces/)).toBeNull()
  })

  test("the API's 403 shows the message in the dialog and does not open the global billing dialog", async () => {
    // The plans are unknown to the dashboard, so the API decides.
    mocks.getProject.mockResolvedValue({ ...personalProject("free"), billing: null })
    mocks.listBillingAccounts.mockResolvedValue(accounts({ personal: "free", team: "free" }))
    mocks.moveProjectToTeam.mockRejectedValue(moveRefusal())
    renderCard()

    fireEvent.click(await screen.findByRole("button", { name: "Move to team" }))
    fireEvent.click(await screen.findByRole("button", { name: "Move project" }))

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(MESSAGE))
    expect(mocks.moveProjectToTeam).toHaveBeenCalledWith("p1", "t1")
    expect(screen.getByRole("link", { name: "Upgrade" }).getAttribute("href")).toBe(`/dashboard/billing/${TEAM_ACCOUNT}`)
    expect(screen.queryByText(/The project could not be moved/)).toBeNull()
    expect(screen.getByText("no global denial")).toBeTruthy()
  })
})

describe("reportBillingDenial with inline plan limit keys", () => {
  test("skips only the named keys", () => {
    expect(reportBillingDenial(moveRefusal(), { inlinePlanLimitKeys: [FREE_ACCOUNTS_MOVE_KEY] })).toBe(false)
    expect(reportBillingDenial(moveRefusal(), { inlinePlanLimitKeys: ["team.seats"] })).toBe(true)
  })
})

describe("the move refusal copy", () => {
  test("names the account to upgrade, or neither when it is unknown", async () => {
    const { freeAccountsMoveMessage, planLimitSentence } = await import("~/lib/dashboard/billing-model")
    expect(freeAccountsMoveMessage("Core")).toBe(MESSAGE)
    expect(freeAccountsMoveMessage(null)).toBe(
      "Moving a project between two Free workspaces is not possible. Upgrade your personal workspace to Pro first.",
    )
    expect(
      planLimitSentence({ code: "plan_limit", key: FREE_ACCOUNTS_MOVE_KEY, limit: false, used: null, plan: "free", resetsAt: null, upgradeUrl: null }),
    ).toBe("Moving a project between two Free workspaces is not possible. Upgrade one of them to Pro first.")
  })
})
