import type { ReactNode } from "react"
import type { BillingAccountSummary } from "@doxahq/contracts/billing"

import type { WorkspaceContextValue } from "~/lib/dashboard/workspace-context"
import { PERSONAL_WORKSPACE_ID, type Workspace } from "~/lib/dashboard/workspace-model"

export function personalWorkspace(billingAccount: BillingAccountSummary | null = null): Workspace {
  return {
    id: PERSONAL_WORKSPACE_ID,
    teamId: null,
    name: "Personal",
    role: "owner",
    memberCount: null,
    projectCount: 1,
    billingAccount,
  }
}

export function workspaceValue(overrides: Partial<WorkspaceContextValue> = {}): WorkspaceContextValue {
  const current = overrides.current === undefined ? personalWorkspace() : overrides.current
  return {
    current,
    workspaces: current ? [current] : [],
    isTeamsPending: false,
    crumb: null,
    isMenuOpen: false,
    setMenuOpen: () => undefined,
    switchTo: () => undefined,
    preloadSwitch: () => undefined,
    ...overrides,
  }
}

/**
 * Stands in for `~/lib/dashboard/workspace-context` in a test that renders a
 * part of the dashboard without the shell:
 * `vi.mock("~/lib/dashboard/workspace-context", async () => (await import("./fixtures/workspace")).workspaceContextModule(() => value))`.
 */
export function workspaceContextModule(read: () => WorkspaceContextValue) {
  return {
    useWorkspace: read,
    useWorkspaceCrumb: () => read().crumb,
    WorkspaceProvider: ({ children }: { children: ReactNode }) => children,
  }
}
