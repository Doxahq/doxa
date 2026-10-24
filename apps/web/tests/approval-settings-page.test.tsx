// @vitest-environment jsdom
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type {
  ApprovalActionSetting,
  ProjectApprovalSettings,
  UserApprovalSettings,
} from "@doxahq/contracts/approval-settings"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { ProjectApprovalsPage } from "~/components/dashboard/project-approvals-page"
import { UserApprovalSettingsSection } from "~/components/dashboard/settings/user-approval-settings-section"
import { changedFlags, changedModes, shownFlags } from "~/lib/dashboard/approval-settings-model"
import { approvalSettingsQueryKeys } from "~/lib/queries/approval-settings"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to: _to, params: _params, ...rest }: { children: ReactNode; to: string; params?: unknown }) => (
    <a href="/settings" {...rest}>{children}</a>
  ),
}))

const api = vi.hoisted(() => ({
  project: null as ProjectApprovalSettings | null,
  user: null as UserApprovalSettings | null,
  updateProject: vi.fn(),
  updateUser: vi.fn(),
}))

vi.mock("~/lib/approval-settings-api", () => ({
  getProjectApprovalSettings: async () => api.project,
  getUserApprovalSettings: async () => api.user,
  updateProjectApprovalSettings: (...args: unknown[]) => api.updateProject(...args),
  updateUserApprovalSettings: (...args: unknown[]) => api.updateUser(...args),
}))

const publish = setting({ actionKind: "docs.publish", title: "Publish a branch" })
const deleteProject = setting({
  actionKind: "project.delete",
  title: "Delete a project",
  allowedModes: ["require_approval", "deny"],
})
const createProject = setting({ actionKind: "project.create", title: "Create a project", defaultMode: "allow", effectiveMode: "allow" })

beforeEach(() => {
  api.project = { projectId: "project-1", canConfigure: true, actions: [publish, deleteProject], eraseBranchAfterPublish: true, requireOtherDecider: false }
  api.user = { actions: [createProject, publish] }
  api.updateProject.mockReset()
  api.updateUser.mockReset()
})

afterEach(cleanup)

describe("approval settings model", () => {
  test("sends only the picks that differ from what the page shows", () => {
    expect(changedModes([publish, deleteProject], { "docs.publish": "require_approval", "project.delete": "deny" })).toEqual({
      "project.delete": "deny",
    })
  })
})

describe("project approval flags", () => {
  const saved = { eraseBranchAfterPublish: true, requireOtherDecider: false }

  test("sends only the flags that differ from the saved values", () => {
    expect(changedFlags(saved, { eraseBranchAfterPublish: true, requireOtherDecider: true })).toEqual({
      requireOtherDecider: true,
    })
    expect(changedFlags(saved, {})).toEqual({})
  })

  test("shows a pick over the saved value", () => {
    expect(shownFlags(saved, { requireOtherDecider: true })).toEqual({
      eraseBranchAfterPublish: true,
      requireOtherDecider: true,
    })
  })
})

describe("project agent approvals page", () => {
  test("offers only the allowed modes of each action", async () => {
    renderWithClient(<ProjectApprovalsPage projectId="project-1" />)
    const publishModes = await screen.findByRole("radiogroup", { name: "Publish a branch" })
    expect(within(publishModes).getByRole("radio", { name: "Ask me" }).getAttribute("aria-checked")).toBe("true")
    expect(within(publishModes).getByRole("radio", { name: "Allow" }).hasAttribute("disabled")).toBe(false)

    const deleteModes = screen.getByRole("radiogroup", { name: "Delete a project" })
    const allow = within(deleteModes).getByRole("radio", { name: "Allow" })
    expect(allow.hasAttribute("disabled")).toBe(true)
    expect(allow.className).toContain("line-through")
    expect(screen.getByText(/never runs without you/)).toBeTruthy()
    expect(screen.getByText("Changes apply to new requests. Pending requests keep their mode.")).toBeTruthy()
  })

  test("saves the changed modes and the erase default", async () => {
    api.updateProject.mockImplementation(async () => ({
      ...api.project,
      actions: [{ ...publish, mode: "deny", effectiveMode: "deny", effectiveSource: "project_setting" }, deleteProject],
      eraseBranchAfterPublish: false,
    }))
    renderWithClient(<ProjectApprovalsPage projectId="project-1" />)
    const save = await screen.findByRole("button", { name: "Save" })
    expect(save.hasAttribute("disabled")).toBe(true)

    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Publish a branch" })).getByRole("radio", { name: "Block" }))
    const erase = screen.getByRole("radiogroup", { name: "Erase the branch after an approved publish" })
    await userEvent.click(within(erase).getByRole("radio", { name: "Keep" }))
    await userEvent.click(save)

    await waitFor(() =>
      expect(api.updateProject).toHaveBeenCalledWith("project-1", {
        modes: { "docs.publish": "deny" },
        eraseBranchAfterPublish: false,
      }),
    )
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(true))
    expect(within(erase).getByRole("radio", { name: "Keep" }).getAttribute("aria-checked")).toBe("true")
  })

  test("saves the second-person rule alone", async () => {
    api.updateProject.mockImplementation(async () => ({ ...api.project, requireOtherDecider: true }))
    renderWithClient(<ProjectApprovalsPage projectId="project-1" />)
    const rule = await screen.findByRole("checkbox", { name: "Require another member to approve" })
    expect((rule as HTMLInputElement).checked).toBe(false)
    await userEvent.click(rule)
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(api.updateProject).toHaveBeenCalledWith("project-1", { modes: {}, requireOtherDecider: true }),
    )
    await waitFor(() => expect((rule as HTMLInputElement).checked).toBe(true))
  })

  test("unticking the rule back is no change", async () => {
    renderWithClient(<ProjectApprovalsPage projectId="project-1" />)
    const rule = await screen.findByRole("checkbox", { name: "Require another member to approve" })
    const save = screen.getByRole("button", { name: "Save" })
    await userEvent.click(rule)
    expect(save.hasAttribute("disabled")).toBe(false)
    await userEvent.click(rule)
    expect(save.hasAttribute("disabled")).toBe(true)
  })

  test("is read only without approvals.configure", async () => {
    if (api.project) api.project = { ...api.project, canConfigure: false }
    renderWithClient(<ProjectApprovalsPage projectId="project-1" />)
    expect(await screen.findByText("Only a project admin can change these settings.")).toBeTruthy()
    const publishModes = screen.getByRole("radiogroup", { name: "Publish a branch" })
    expect(within(publishModes).getAllByRole("radio").every((radio) => radio.hasAttribute("disabled"))).toBe(true)
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
  })

  test("shows the save error", async () => {
    api.updateProject.mockRejectedValue(new Error("You cannot change the approval settings of this project."))
    renderWithClient(<ProjectApprovalsPage projectId="project-1" />)
    await userEvent.click(
      within(await screen.findByRole("radiogroup", { name: "Publish a branch" })).getByRole("radio", { name: "Allow" }),
    )
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    expect((await screen.findByRole("alert")).textContent).toContain("You cannot change")
  })
})

describe("user agent approvals section", () => {
  test("saves a user default and refreshes the project pages", async () => {
    api.updateUser.mockImplementation(async () => ({
      actions: [{ ...createProject, mode: "require_approval", effectiveMode: "require_approval", effectiveSource: "user_setting" }, publish],
    }))
    const client = renderWithClient(<UserApprovalSettingsSection />)
    client.setQueryData(approvalSettingsQueryKeys.project("project-1"), api.project)
    const createModes = await screen.findByRole("radiogroup", { name: "Create a project" })
    await userEvent.click(within(createModes).getByRole("radio", { name: "Ask me" }))
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(api.updateUser).toHaveBeenCalledWith({ modes: { "project.create": "require_approval" } }))
    await waitFor(() =>
      expect(client.getQueryState(approvalSettingsQueryKeys.project("project-1"))?.isInvalidated).toBe(true),
    )
  })
})

function renderWithClient(ui: ReactNode): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
  return client
}

function setting(overrides: Partial<ApprovalActionSetting> & Pick<ApprovalActionSetting, "actionKind" | "title">): ApprovalActionSetting {
  return {
    allowedModes: ["allow", "require_approval", "deny"],
    defaultMode: "require_approval",
    mode: null,
    effectiveMode: "require_approval",
    effectiveSource: "action_default",
    ...overrides,
  }
}
