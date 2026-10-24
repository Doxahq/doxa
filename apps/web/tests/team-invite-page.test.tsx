// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { TeamInvitePage } from "~/components/teams/team-invite-page"
import { ApiRequestError } from "~/lib/api-errors"

const navigate = vi.fn()
const api = vi.hoisted(() => ({ getTeamInvite: vi.fn(), acceptTeamInvite: vi.fn() }))

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => navigate,
}))

vi.mock("~/lib/teams-api", () => ({
  getTeamInvite: (token: string) => api.getTeamInvite(token),
  acceptTeamInvite: (token: string) => api.acceptTeamInvite(token),
}))

const TEAM_ID = "11111111-1111-4111-8111-111111111111"

beforeEach(() => {
  navigate.mockReset()
  api.getTeamInvite.mockReset()
  api.acceptTeamInvite.mockReset()
})

afterEach(cleanup)

describe("team invite page", () => {
  test("shows the team and role, then joins and opens the team", async () => {
    api.getTeamInvite.mockResolvedValue({
      teamName: "Acme",
      role: "editor",
      expiresAt: "2026-10-12T00:00:00.000Z",
      alreadyMember: false,
    })
    api.acceptTeamInvite.mockResolvedValue({ teamId: TEAM_ID, role: "editor" })
    renderPage()

    expect(await screen.findByText("You are invited to join Acme.")).toBeTruthy()
    expect(screen.getByText("Editor")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Accept and join" }))

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/dashboard/teams/$teamId", params: { teamId: TEAM_ID }, replace: true }),
    )
  })

  test("says why a used link fails", async () => {
    api.getTeamInvite.mockRejectedValue(new ApiRequestError("This invite link was already used.", 410, "invite_used"))
    renderPage()
    expect(await screen.findByText("Invite already used")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Accept and join" })).toBeNull()
  })

  test("shows an accept failure, such as a link that expired meanwhile", async () => {
    api.getTeamInvite.mockResolvedValue({
      teamName: "Acme",
      role: "viewer",
      expiresAt: "2026-10-12T00:00:00.000Z",
      alreadyMember: false,
    })
    api.acceptTeamInvite.mockRejectedValue(new ApiRequestError("expired", 410, "invite_expired"))
    renderPage()
    await userEvent.click(await screen.findByRole("button", { name: "Accept and join" }))
    expect(await screen.findByText("Invite expired")).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
  })
})

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <TeamInvitePage token="token" />
    </QueryClientProvider>,
  )
}
