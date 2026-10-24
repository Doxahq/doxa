// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { DocsBranchStatus, NamedDocsBranch } from "@doxahq/contracts/docs-branches"
import { afterEach, describe, expect, test, vi } from "vitest"

import { BranchStatusBanner } from "~/components/dashboard/content/branches/branch-status-banner"
import { resolveSelectedBranchRef } from "~/lib/dashboard/use-branch-context"

afterEach(cleanup)

describe("docs branch dashboard", () => {
  test("a branch behind main shows the status banner and opens synchronization", async () => {
    const user = userEvent.setup()
    const onSynchronize = vi.fn()
    render(<BranchStatusBanner status={namedStatus()} onSynchronize={onSynchronize} />)

    expect(screen.getByRole("status").textContent).toContain("2 new publications")
    await user.click(screen.getByRole("button", { name: "Synchronize" }))
    expect(onSynchronize).toHaveBeenCalledTimes(1)
  })

  test("a missing stored branch falls back to main", () => {
    expect(resolveSelectedBranchRef("missing-branch", [namedBranch()])).toBe("main")
    expect(resolveSelectedBranchRef(namedBranch().id, [namedBranch()])).toBe(namedBranch().id)
  })
})

function namedStatus(): DocsBranchStatus {
  return {
    branch: {
      id: "10000000-0000-4000-8000-000000000001",
      kind: "named",
      name: "new-guides",
      revision: 4,
    },
    baseVersionId: "20000000-0000-4000-8000-000000000001",
    main: {
      versionId: "20000000-0000-4000-8000-000000000002",
      versionNumber: 12,
      latestPublication: {
        kind: "generation",
        actorName: null,
        createdAt: new Date(Date.now() - 600_000).toISOString(),
      },
    },
    behind: true,
    publicationsSinceBase: 2,
    changeCount: 3,
    preview: null,
  }
}

function namedBranch(): NamedDocsBranch {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    kind: "named",
    name: "new-guides",
    purpose: "user",
    baseVersionId: "20000000-0000-4000-8000-000000000001",
    createdFromBranchId: null,
    createdBy: { kind: "user" },
    revision: 1,
    changeCount: 2,
    createdAt: "2026-09-24T10:00:00.000Z",
    updatedAt: "2026-09-24T11:00:00.000Z",
  }
}
