// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import type { DashboardApprovalRequest } from "@doxahq/contracts/approval-requests"
import type { BranchRef } from "@doxahq/contracts/docs-branches"
import { afterEach, describe, expect, test, vi } from "vitest"

import { useAgentPublishRequest } from "~/lib/dashboard/use-agent-publish-request"

const BRANCH = "00000000-0000-4000-8000-000000000001"
const OTHER_BRANCH = "00000000-0000-4000-8000-000000000002"

vi.mock("~/lib/approval-requests-api", () => ({
  getApprovalRequest: async () => publishRequest(),
  listApprovalRequests: async () => ({ requests: [] }),
}))

afterEach(cleanup)

describe("agent publish request link", () => {
  test("opens the linked request once, then leaves the URL and the branch free", async () => {
    const selectBranch = vi.fn()
    const openApproval = vi.fn()
    const onLinkOpened = vi.fn()
    const { result, rerender } = renderHook(
      ({ linkedRequestId, branchRef }: { linkedRequestId: string | null; branchRef: BranchRef }) =>
        useAgentPublishRequest({ projectId: "project-1", linkedRequestId, branchRef, selectBranch, openApproval, onLinkOpened }),
      { wrapper: makeWrapper(), initialProps: { linkedRequestId: "request-1" as string | null, branchRef: "main" as BranchRef } },
    )

    await waitFor(() => expect(selectBranch).toHaveBeenCalledWith(BRANCH))
    rerender({ linkedRequestId: "request-1", branchRef: BRANCH })
    await waitFor(() => expect(onLinkOpened).toHaveBeenCalledTimes(1))
    expect(openApproval).toHaveBeenCalledTimes(1)

    // The route removed `?request=`; the menu still shows the request.
    rerender({ linkedRequestId: null, branchRef: BRANCH })
    expect(result.current?.id).toBe("request-1")

    // The user switches branch: nothing pulls them back.
    rerender({ linkedRequestId: null, branchRef: OTHER_BRANCH })
    expect(selectBranch).toHaveBeenCalledTimes(1)
    expect(result.current).toBeNull()
  })

  test("gives up on a branch that cannot be selected", async () => {
    const selectBranch = vi.fn()
    const onLinkOpened = vi.fn()
    const { rerender } = renderHook(
      ({ branchRef }: { branchRef: BranchRef }) =>
        useAgentPublishRequest({
          projectId: "project-1",
          linkedRequestId: "request-1",
          branchRef,
          selectBranch,
          openApproval: vi.fn(),
          onLinkOpened,
        }),
      { wrapper: makeWrapper(), initialProps: { branchRef: "main" as BranchRef } },
    )
    await waitFor(() => expect(selectBranch).toHaveBeenCalledTimes(1))
    // The erased branch resolves back to main.
    rerender({ branchRef: OTHER_BRANCH })
    rerender({ branchRef: "main" })
    await waitFor(() => expect(onLinkOpened).toHaveBeenCalledTimes(1))
    expect(selectBranch).toHaveBeenCalledTimes(1)
  })
})

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function publishRequest(): DashboardApprovalRequest {
  return {
    id: "request-1",
    projectId: "project-1",
    actionKind: "docs.publish",
    actionAvailable: true,
    status: "pending",
    title: "Publish a branch",
    headline: "Publish 3 changes from agent-fix",
    effects: [],
    summary: null,
    requestedBy: { userId: "owner-1", name: null, clientName: "Claude Code" },
    decidedBy: null,
    decisionNote: null,
    policySource: "action_default",
    reviewSurface: { kind: "publish_menu" },
    branchId: BRANCH,
    confirmationText: null,
    error: null,
    createdAt: "2026-10-04T12:00:00.000Z",
    expiresAt: "2026-10-11T12:00:00.000Z",
    decidedAt: null,
    completedAt: null,
    inputs: {},
    result: null,
    viewer: { canApprove: true, reason: null, canReject: true },
  }
}
