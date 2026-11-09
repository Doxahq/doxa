// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { DashboardApprovalRequest } from "@doxahq/contracts/approval-requests"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { ApprovalDecision } from "~/components/dashboard/requests/approval-decision"
import { closedRequestMessage } from "~/lib/dashboard/approval-request-model"
import { formatRelativeAge } from "~/lib/dashboard/relative-time"

const approve = vi.fn()
const reject = vi.fn()
const settings = vi.hoisted(() => ({ eraseBranchAfterPublish: true, requests: 0 }))

vi.mock("~/lib/approval-requests-api", () => ({
  approveApprovalRequest: (...args: unknown[]) => approve(...args),
  rejectApprovalRequest: (...args: unknown[]) => reject(...args),
}))

vi.mock("~/lib/approval-settings-api", () => ({
  getProjectApprovalSettings: async (projectId: string) => {
    settings.requests += 1
    return { projectId, canConfigure: true, actions: [], eraseBranchAfterPublish: settings.eraseBranchAfterPublish }
  },
}))

beforeEach(() => {
  approve.mockReset()
  reject.mockReset()
  settings.eraseBranchAfterPublish = true
  settings.requests = 0
})

afterEach(cleanup)

describe("approval request model", () => {
  test("explains why a closed request cannot be decided", () => {
    expect(closedRequestMessage("pending")).toBeNull()
    expect(closedRequestMessage("stale")).toMatch(/must ask again/)
    expect(closedRequestMessage("completed")).toMatch(/already decided/)
  })

  test("formats the request age relative to now", () => {
    const now = Date.parse("2026-10-04T12:00:00Z")
    expect(formatRelativeAge("2026-10-04T11:58:00Z", now)).toBe("2 minutes ago")
  })
})

describe("approval decision", () => {
  test("approves a request", async () => {
    approve.mockResolvedValue(request({ status: "completed" }))
    renderDecision(request())
    await userEvent.click(screen.getByRole("button", { name: "Approve" }))
    await waitFor(() => expect(approve).toHaveBeenCalledWith("project-1", "request-1", {}, expect.any(Function)))
    expect(await screen.findByText("This request is already decided.")).toBeTruthy()
  })

  test("needs the typed project name for a destructive action", async () => {
    approve.mockResolvedValue(request({ status: "completed" }))
    renderDecision(request({ confirmationText: "Acme" }))
    const button = screen.getByRole("button", { name: "Approve" })
    expect(button.hasAttribute("disabled")).toBe(true)
    await userEvent.type(screen.getByRole("textbox"), "Acme")
    expect(button.hasAttribute("disabled")).toBe(false)
    await userEvent.click(button)
    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith("project-1", "request-1", { confirmation: "Acme" }, expect.any(Function)),
    )
  })

  test("erases the branch of an approved publish by default", async () => {
    approve.mockResolvedValue(request({ status: "completed" }))
    renderDecision(publishRequest())
    const checkbox = screen.getByRole<HTMLInputElement>("checkbox", { name: "Erase this branch after publish" })
    await waitFor(() => expect(checkbox.disabled).toBe(false))
    expect(checkbox.checked).toBe(true)
    await userEvent.click(screen.getByRole("button", { name: "Approve" }))
    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith("project-1", "request-1", { eraseBranch: true }, expect.any(Function)),
    )
  })

  test("takes the default from the project setting", async () => {
    settings.eraseBranchAfterPublish = false
    approve.mockResolvedValue(request({ status: "completed" }))
    renderDecision(publishRequest())
    const checkbox = screen.getByRole<HTMLInputElement>("checkbox", { name: "Erase this branch after publish" })
    await waitFor(() => expect(checkbox.disabled).toBe(false))
    expect(checkbox.checked).toBe(false)
    await userEvent.click(screen.getByRole("button", { name: "Approve" }))
    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith("project-1", "request-1", { eraseBranch: false }, expect.any(Function)),
    )
  })

  test("waits for the erase default before it approves a publish", async () => {
    renderDecision(publishRequest())
    expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(true)
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(false))
  })

  test("keeps the branch when the decider unticks the box", async () => {
    approve.mockResolvedValue(request({ status: "completed" }))
    renderDecision(publishRequest())
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(false))
    await userEvent.click(screen.getByRole("checkbox", { name: "Erase this branch after publish" }))
    await userEvent.click(screen.getByRole("button", { name: "Approve" }))
    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith("project-1", "request-1", { eraseBranch: false }, expect.any(Function)),
    )
  })

  test("shows no erase box for other actions and never reads the setting", () => {
    renderDecision(request())
    expect(screen.queryByRole("checkbox")).toBeNull()
    expect(settings.requests).toBe(0)
  })

  test("sends a rejection with a reason", async () => {
    reject.mockResolvedValue(request({ status: "rejected", decisionNote: "Not yet." }))
    renderDecision(request())
    await userEvent.click(screen.getByRole("button", { name: "Reject" }))
    await userEvent.type(screen.getByRole("textbox"), "Not yet.")
    await userEvent.click(screen.getByRole("button", { name: "Send rejection" }))
    await waitFor(() => expect(reject).toHaveBeenCalledWith("project-1", "request-1", "Not yet."))
    expect(await screen.findByText("Reason: Not yet.")).toBeTruthy()
  })

  test("disables Approve with the reason when another member must approve, and keeps Reject", async () => {
    reject.mockResolvedValue(request({ status: "rejected" }))
    renderDecision(
      publishRequest({ confirmationText: "Acme", viewer: { canApprove: false, reason: "other_decider_required", canReject: true } }),
    )
    expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByText(/another member must approve this request/)).toBeTruthy()
    // Approve-only fields are hidden, and the erase default is never read.
    expect(screen.queryByRole("checkbox")).toBeNull()
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(settings.requests).toBe(0)

    const rejectButton = screen.getByRole("button", { name: "Reject" })
    expect(rejectButton.hasAttribute("disabled")).toBe(false)
    await userEvent.click(rejectButton)
    await userEvent.click(screen.getByRole("button", { name: "Send rejection" }))
    await waitFor(() => expect(reject).toHaveBeenCalledWith("project-1", "request-1", ""))
    expect(approve).not.toHaveBeenCalled()
  })

  test("disables Approve when the viewer's role lacks the capability", () => {
    renderDecision(request({ viewer: { canApprove: false, reason: "missing_capability", canReject: true } }))
    expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByText("Your role cannot approve this request.")).toBeTruthy()
  })

  test("hides Reject when the viewer's role cannot decide requests", () => {
    renderDecision(request({ viewer: { canApprove: false, reason: "missing_capability", canReject: false } }))
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull()
    expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByText("Your role cannot approve or reject this request.")).toBeTruthy()
  })

  test("shows no reason when the viewer may approve", () => {
    renderDecision(request())
    expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(false)
    expect(screen.queryByText(/must approve|cannot approve/)).toBeNull()
  })

  test("shows no controls for a stale request", () => {
    renderDecision(request({ status: "stale" }))
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull()
    expect(screen.getByText(/must ask again/)).toBeTruthy()
  })
})

function renderDecision(detail: DashboardApprovalRequest) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  render(<ApprovalDecision request={detail} />, { wrapper })
}

function publishRequest(overrides: Partial<DashboardApprovalRequest> = {}): DashboardApprovalRequest {
  return request({
    actionKind: "docs.publish",
    title: "Publish a branch",
    headline: "Publish 3 changes from agent-fix",
    reviewSurface: { kind: "publish_menu" },
    branchId: "00000000-0000-4000-8000-000000000001",
    inputs: { branchId: "00000000-0000-4000-8000-000000000001", eraseBranch: false },
    ...overrides,
  })
}

function request(overrides: Partial<DashboardApprovalRequest> = {}): DashboardApprovalRequest {
  return {
    id: "request-1",
    projectId: "project-1",
    actionKind: "domain.remove",
    actionAvailable: true,
    status: "pending",
    title: "Remove a custom domain",
    headline: "Remove docs.acme.com",
    effects: ["The site stops at docs.acme.com."],
    summary: null,
    requestedBy: { userId: "owner-1", name: null, clientName: "Claude Code" },
    decidedBy: null,
    decisionNote: null,
    policySource: "action_default",
    reviewSurface: { kind: "approval_page" },
    branchId: null,
    confirmationText: null,
    error: null,
    createdAt: "2026-10-04T12:00:00.000Z",
    expiresAt: "2026-10-11T12:00:00.000Z",
    decidedAt: null,
    completedAt: null,
    inputs: {},
    result: null,
    viewer: { canApprove: true, reason: null, canReject: true },
    ...overrides,
  }
}
