// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { CreateTeamInviteInput, TeamDetail, TeamInvite } from "@doxahq/contracts/teams"
import { afterEach, describe, expect, test, vi } from "vitest"

import { TeamInvitesSection } from "~/components/dashboard/teams/team-invites-section"
import { useTeam } from "~/lib/dashboard/use-teams"
import { teamQueryKeys } from "~/lib/queries/teams"

const TEAM_ID = "00000000-0000-4000-8000-0000000000aa"
const FIRST = invite("aaaaaaaa-0000-4000-8000-000000000001", "https://doxa.so/invite/first-token")
const SECOND = invite("aaaaaaaa-0000-4000-8000-000000000002", "https://doxa.so/invite/second-token")

const api = vi.hoisted(() => ({
  getTeam: vi.fn<() => Promise<TeamDetail>>(),
  createTeamInvite: vi.fn<() => Promise<{ invite: TeamInvite }>>(),
  revokeTeamInvite: vi.fn<() => Promise<void>>(),
}))

vi.mock("~/lib/teams-api", () => api)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("team invites section", () => {
  test("shows each pending invite's link with a copy button", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    renderSection(team([FIRST, SECOND]))

    const rows = within(screen.getByRole("list", { name: "Pending invites" })).getAllByRole("listitem")
    expect(rows).toHaveLength(2)
    expect(within(rows[1]).getByLabelText("Invite link").textContent).toBe(SECOND.url)

    await userEvent.click(within(rows[1]).getByRole("button", { name: "Copy" }))
    expect(writeText).toHaveBeenCalledWith(SECOND.url)
    expect(within(rows[1]).getByRole("button", { name: "Copied" })).toBeTruthy()
    expect(within(rows[0]).getByRole("button", { name: "Copy" })).toBeTruthy()
  })

  test("never shows a link in the create card", () => {
    renderSection(team([FIRST]))
    const createButton = screen.getByRole("button", { name: "Create invite link" })
    const createCard = createButton.closest(".surface-card")
    expect(createCard).not.toBeNull()
    expect(createCard?.textContent).not.toContain(FIRST.url)
    expect(screen.getAllByLabelText("Invite link")).toHaveLength(1)
  })

  test("explains an older invite whose link cannot be shown", () => {
    renderSection(team([{ ...FIRST, url: null }]))
    expect(screen.queryByLabelText("Invite link")).toBeNull()
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull()
    expect(screen.getByText("Link not available. Revoke it and create a new one.")).toBeTruthy()
  })
})

describe("invites by email", () => {
  test("sends the invite to the address, then clears the field", async () => {
    const { onCreate } = renderSection(team([]))
    const field = screen.getByLabelText("Email address of the new member")

    await userEvent.type(field, " grace@example.com ")
    await userEvent.click(screen.getByRole("button", { name: "Send invite" }))

    expect(onCreate).toHaveBeenCalledWith({ role: "editor", email: "grace@example.com" })
    await waitFor(() => expect((field as HTMLInputElement).value).toBe(""))
  })

  test("creates a link only when the field is empty", async () => {
    const { onCreate } = renderSection(team([]))

    await userEvent.click(screen.getByRole("button", { name: "Create invite link" }))
    expect(onCreate).toHaveBeenCalledWith({ role: "editor" })
  })

  test("shows the address of an invite sent by email", () => {
    renderSection(team([{ ...FIRST, email: "grace@example.com" }]))
    expect(screen.getByText("Sent to grace@example.com")).toBeTruthy()
  })
})

describe("invite list cache", () => {
  test("a new invite joins the pending list with its link", async () => {
    api.getTeam.mockResolvedValue(team([FIRST]))
    api.createTeamInvite.mockResolvedValue({ invite: SECOND })
    const { client, result } = renderTeam()
    await waitFor(() => expect(result.current.team).not.toBeNull())

    api.getTeam.mockResolvedValue(team([FIRST, SECOND]))
    await act(() => result.current.createInvite({ role: "editor" }))
    await waitFor(() => expect(result.current.team?.invites).toEqual([FIRST, SECOND]))
    expect(client.getQueryData<TeamDetail>(teamQueryKeys.detail(TEAM_ID))?.invites.map(({ url }) => url)).toEqual([
      FIRST.url,
      SECOND.url,
    ])
  })

  test("a revoked invite leaves the list, and its link with it", async () => {
    api.getTeam.mockResolvedValue(team([FIRST, SECOND]))
    api.revokeTeamInvite.mockResolvedValue(undefined)
    const { result } = renderTeam()
    await waitFor(() => expect(result.current.team?.invites).toHaveLength(2))

    // The refetch is held back: the row must go before the server answers again.
    api.getTeam.mockReturnValue(new Promise<TeamDetail>(() => undefined))
    act(() => result.current.revokeInvite(FIRST.id))
    await waitFor(() => expect(result.current.team?.invites).toEqual([SECOND]))
  })
})

function renderSection(detail: TeamDetail) {
  const onCreate = vi.fn<(input: CreateTeamInviteInput) => Promise<void>>().mockResolvedValue(undefined)
  render(
    <TeamInvitesSection
      team={detail}
      isCreating={false}
      createError={null}
      revokingInviteId={null}
      revokeError={null}
      onCreate={onCreate}
      onRevoke={vi.fn()}
    />,
  )
  return { onCreate }
}

function renderTeam() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, ...renderHook(() => useTeam(TEAM_ID), { wrapper }) }
}

function invite(id: string, url: string): TeamInvite {
  return {
    id,
    url,
    email: null,
    role: "editor",
    createdBy: { userId: "owner-1", name: "Olivia" },
    createdAt: "2026-10-05T10:00:00.000Z",
    expiresAt: "2026-10-12T10:00:00.000Z",
  }
}

function team(invites: TeamInvite[]): TeamDetail {
  return {
    id: TEAM_ID,
    name: "Acme",
    role: "owner",
    permissions: { manage: true, delete: true },
    members: [],
    invites,
    projects: [],
    createdAt: "2026-10-04T12:00:00.000Z",
  }
}
