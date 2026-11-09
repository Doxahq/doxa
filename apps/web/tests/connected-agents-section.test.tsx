// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AgentGrantList, AgentGrantSummary } from "@doxahq/contracts/agent-access"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { ConnectedAgentsSection } from "~/components/dashboard/settings/connected-agents-section"
import { formatGrantDate, formatGrantProjectScope } from "~/lib/dashboard/connected-agents-model"

const listAgentGrants = vi.fn<() => Promise<AgentGrantList>>()
const revokeAgentGrant = vi.fn<(grantId: string) => Promise<void>>()

vi.mock("~/lib/agent-access-api", () => ({
  listAgentGrants: () => listAgentGrants(),
  revokeAgentGrant: (grantId: string) => revokeAgentGrant(grantId),
}))

beforeEach(() => {
  listAgentGrants.mockReset()
  revokeAgentGrant.mockReset()
  revokeAgentGrant.mockResolvedValue(undefined)
})

afterEach(cleanup)

describe("connected agents section", () => {
  test("shows the empty state when no agent is connected", async () => {
    listAgentGrants.mockResolvedValue({ grants: [] })
    renderSection()

    expect(await screen.findByText("No connected agents")).toBeTruthy()
  })

  test("lists each grant with its scopes and project scope", async () => {
    listAgentGrants.mockResolvedValue({
      grants: [
        grant({ grantId: "g1", clientName: "Claude Code" }),
        grant({
          grantId: "g2",
          clientName: "Cursor",
          scopes: ["projects:read"],
          projectScope: {
            kind: "selected",
            projectIds: [
              "11111111-1111-4111-8111-111111111111",
              "22222222-2222-4222-8222-222222222222",
            ],
          },
          lastActivityAt: null,
          expiresAt: null,
        }),
      ],
    })
    renderSection()

    const claude = await findRow("Claude Code")
    expect(within(claude).getByText("docs:read")).toBeTruthy()
    expect(within(claude).getByText("docs:write")).toBeTruthy()
    expect(within(claude).getByText(/All projects/)).toBeTruthy()

    const cursor = await findRow("Cursor")
    expect(within(cursor).getByText(/2 projects/)).toBeTruthy()
    expect(within(cursor).getByText(/Last activity —/)).toBeTruthy()
  })

  test("revoke asks for a confirmation in the row, then refreshes the list", async () => {
    listAgentGrants.mockResolvedValueOnce({ grants: [grant({ grantId: "g1", clientName: "Claude Code" })] })
    listAgentGrants.mockResolvedValueOnce({ grants: [] })
    const user = userEvent.setup()
    renderSection()

    await user.click(await screen.findByRole("button", { name: "Revoke" }))
    expect(screen.getByText("Revoke access for Claude Code? It stops working at once.")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByText(/Revoke access for Claude Code/)).toBeNull()
    expect(revokeAgentGrant).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Revoke" }))
    await user.click(screen.getByRole("button", { name: "Revoke access" }))

    await waitFor(() => expect(revokeAgentGrant).toHaveBeenCalledWith("g1"))
    expect(await screen.findByText("No connected agents")).toBeTruthy()
    expect(listAgentGrants).toHaveBeenCalledTimes(2)
  })

  test("a failed revoke keeps the row and shows the error", async () => {
    listAgentGrants.mockResolvedValue({ grants: [grant({ grantId: "g1", clientName: "Claude Code" })] })
    revokeAgentGrant.mockRejectedValue(new Error("Grant not found"))
    const user = userEvent.setup()
    renderSection()

    await user.click(await screen.findByRole("button", { name: "Revoke" }))
    await user.click(screen.getByRole("button", { name: "Revoke access" }))

    expect((await screen.findByRole("alert")).textContent).toBe("Grant not found")
    expect(screen.getByText("Claude Code")).toBeTruthy()
  })
})

describe("connected agents formatting", () => {
  test("formats the project scope", () => {
    expect(formatGrantProjectScope({ kind: "all" })).toBe("All projects")
    expect(
      formatGrantProjectScope({ kind: "selected", projectIds: ["11111111-1111-4111-8111-111111111111"] }),
    ).toBe("1 project")
  })

  test("formats dates and a missing date", () => {
    expect(formatGrantDate("2026-10-04T12:00:00.000Z", "en-US")).toBe("Oct 4, 2026")
    expect(formatGrantDate(null)).toBe("—")
  })
})

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  return render(<ConnectedAgentsSection />, { wrapper: Wrapper })
}

async function findRow(clientName: string): Promise<HTMLElement> {
  const name = await screen.findByText(clientName)
  const row = name.closest("li")
  if (!row) throw new Error(`No row for ${clientName}`)
  return row
}

function grant(overrides: Partial<AgentGrantSummary>): AgentGrantSummary {
  return {
    grantId: "g1",
    clientName: "Claude Code",
    scopes: ["docs:read", "docs:write"],
    projectScope: { kind: "all" },
    createdAt: "2026-10-01T09:00:00.000Z",
    lastActivityAt: "2026-10-03T09:00:00.000Z",
    expiresAt: null,
    ...overrides,
  }
}
