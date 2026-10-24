// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import type { TeamDetail } from "@doxahq/contracts/teams"
import { afterEach, describe, expect, test, vi } from "vitest"

import { useTeam } from "~/lib/dashboard/use-teams"
import { approvalSettingsQueryKeys } from "~/lib/queries/approval-settings"
import { teamQueryKeys } from "~/lib/queries/teams"

const TEAM_ID = "00000000-0000-4000-8000-0000000000aa"

vi.mock("~/lib/teams-api", () => ({
  getTeam: async () => team(),
  changeTeamMemberRole: async () => team(),
  removeTeamMember: async () => undefined,
}))

afterEach(cleanup)

describe("team access refresh", () => {
  test("a role change refreshes the teams list and the approval settings", async () => {
    const { client, result } = renderTeam()
    const invalidate = vi.spyOn(client, "invalidateQueries")
    result.current.changeRole("user-2", "viewer")
    await waitFor(() => expect(invalidatedKeys(invalidate)).toContainEqual(teamQueryKeys.list()))
    expect(invalidatedKeys(invalidate)).toContainEqual(approvalSettingsQueryKeys.projects())
  })

  test("removing a member refreshes the approval settings", async () => {
    const { client, result } = renderTeam()
    const invalidate = vi.spyOn(client, "invalidateQueries")
    await result.current.removeMember("user-2")
    expect(invalidatedKeys(invalidate)).toContainEqual(approvalSettingsQueryKeys.projects())
  })
})

function renderTeam() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, ...renderHook(() => useTeam(TEAM_ID), { wrapper }) }
}

function invalidatedKeys(spy: { mock: { calls: unknown[][] } }): unknown[] {
  return spy.mock.calls.map(([filters]) =>
    typeof filters === "object" && filters !== null && "queryKey" in filters ? filters.queryKey : null,
  )
}

function team(): TeamDetail {
  return {
    id: TEAM_ID,
    name: "Acme",
    role: "owner",
    permissions: { manage: true, delete: true },
    members: [],
    invites: [],
    projects: [],
    createdAt: "2026-10-04T12:00:00.000Z",
  }
}
