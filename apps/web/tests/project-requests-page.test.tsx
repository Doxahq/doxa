// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ApprovalRequestStatus, ApprovalRequestSummary } from "@doxahq/contracts/approval-requests"
import { afterEach, describe, expect, test, vi } from "vitest"

import { ProjectRequestsPage } from "~/components/dashboard/requests/project-requests-page"
import {
  installRadixSelectPolyfills,
  pickSelectOption,
  readSelectOptions,
  selectedLabel,
} from "./support/radix-select"

installRadixSelectPolyfills()

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params, to: _to, ...rest }: { children: ReactNode; params: { requestId: string }; to: string }) => (
    <a href={`/approve/${params.requestId}`} {...rest}>{children}</a>
  ),
}))

const api = vi.hoisted(() => ({ statusQueries: [] as (string | undefined)[] }))

vi.mock("~/lib/approval-requests-api", () => ({
  listApprovalRequests: async (_projectId: string, status?: ApprovalRequestStatus) => {
    api.statusQueries.push(status)
    const requests = [
      summary("pending-1", "pending"),
      summary("done-1", "completed"),
      summary("rejected-1", "rejected"),
      summary("pending-2", "pending", "Cursor"),
    ]
    return { requests: status ? requests.filter((request) => request.status === status) : requests }
  },
}))

afterEach(() => {
  cleanup()
  api.statusQueries = []
})

describe("agent requests list", () => {
  test("opens only pending requests", async () => {
    renderPage()
    await screen.findByText("Request pending-1")
    const links = screen.getAllByRole("link")
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/approve/pending-1", "/approve/pending-2"])
    expect(screen.getByText("Request done-1").closest("a")).toBeNull()
    expect(screen.getByText("Request rejected-1").closest("a")).toBeNull()
  })
})

describe("request filters", () => {
  test("asks the server for one status", async () => {
    renderPage()
    await screen.findByText("Request done-1")
    await pickSelectOption("Filter by status", "Pending")

    await waitFor(() => expect(screen.queryByText("Request done-1")).toBeNull())
    expect(api.statusQueries).toEqual([undefined, "pending"])
    expect(screen.getByText("Request pending-1")).toBeTruthy()
    expect(screen.getByText("Request pending-2")).toBeTruthy()
  })

  test("lists each agent once and shows only the chosen agent's requests", async () => {
    renderPage()
    await screen.findByText("Request pending-2")
    expect(await readSelectOptions("Filter by agent")).toEqual(["All agents", "Claude Code", "Cursor"])

    await pickSelectOption("Filter by agent", "Cursor")

    expect(screen.getByText("Request pending-2")).toBeTruthy()
    expect(screen.queryByText("Request pending-1")).toBeNull()
    expect(screen.queryByText("Request done-1")).toBeNull()
  })

  test("offers to clear filters that match nothing", async () => {
    renderPage()
    await screen.findByText("Request pending-2")
    await pickSelectOption("Filter by agent", "Cursor")
    await pickSelectOption("Filter by status", "Rejected")

    await screen.findByText("No matching requests")
    // The chosen agent stays selectable while its requests are hidden.
    expect(selectedLabel("Filter by agent")).toBe("Cursor")

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }))
    await screen.findByText("Request done-1")
    expect(selectedLabel("Filter by status")).toBe("All statuses")
  })
})

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ProjectRequestsPage projectId="project-1" />
    </QueryClientProvider>,
  )
}

function summary(id: string, status: ApprovalRequestStatus, clientName = "Claude Code"): ApprovalRequestSummary {
  return {
    id,
    projectId: "project-1",
    actionKind: "docs.publish",
    actionAvailable: true,
    status,
    title: "Publish a branch",
    headline: `Request ${id}`,
    effects: [],
    summary: null,
    requestedBy: { userId: "owner-1", name: null, clientName },
    decidedBy: null,
    decisionNote: null,
    policySource: "action_default",
    reviewSurface: { kind: "publish_menu" },
    branchId: null,
    confirmationText: null,
    error: null,
    createdAt: "2026-10-04T12:00:00.000Z",
    expiresAt: "2026-10-11T12:00:00.000Z",
    decidedAt: null,
    completedAt: null,
  }
}
