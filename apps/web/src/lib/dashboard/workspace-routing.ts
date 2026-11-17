import type { ProjectDto } from "@doxahq/contracts"
import type { BillingAccountSummary } from "@doxahq/contracts/billing"

import {
  findWorkspace,
  landingProjectIdIn,
  PERSONAL_WORKSPACE_ID,
  workspaceIdOfBillingAccount,
  workspaceIdOfProject,
  type Workspace,
  type WorkspaceId,
} from "~/lib/dashboard/workspace-model"

/** The billing pages of one account. */
export type BillingPagePath = "plan" | "credits"

/**
 * What decides the workspace of a page:
 * - `project`: a project page belongs to that project's workspace;
 * - `billing`: a billing page belongs to the account's workspace;
 * - `chosen`: every other page shows the workspace the person chose.
 */
export type WorkspacePageScope =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "billing"; readonly accountId: string; readonly page: BillingPagePath }
  | { readonly kind: "chosen" }

const PROJECT_PAGE = /^\/dashboard\/projects\/([^/]+)(?:\/|$)/
const BILLING_PAGE = /^\/dashboard\/billing\/([^/]+)(\/credits)?\/?$/
/** The pages that show the workspace in the top bar: project pages, New project and billing. */
const WORKSPACE_PAGE = /^\/dashboard\/(?:projects\/[^/]+|billing\/[^/]+)(?:\/|$)/

export function workspacePageScope(pathname: string): WorkspacePageScope {
  const project = PROJECT_PAGE.exec(pathname)
  if (project?.[1] && project[1] !== "new") return { kind: "project", projectId: decodeURIComponent(project[1]) }
  const billing = BILLING_PAGE.exec(pathname)
  if (billing?.[1]) {
    return { kind: "billing", accountId: decodeURIComponent(billing[1]), page: billing[2] ? "credits" : "plan" }
  }
  return { kind: "chosen" }
}

export function isWorkspacePage(pathname: string): boolean {
  return WORKSPACE_PAGE.test(pathname)
}

export interface CurrentWorkspaceInput {
  readonly scope: WorkspacePageScope
  readonly workspaces: readonly Workspace[]
  /** Undefined while the projects list loads. */
  readonly projects: readonly ProjectDto[] | undefined
  /** Undefined while the account list loads, or when billing is off. */
  readonly billingAccounts: readonly BillingAccountSummary[] | undefined
  /** Undefined before the browser storage is read (the server render and hydration). */
  readonly storedId: WorkspaceId | null | undefined
  /** The project opened last in any workspace, from `doxa:last-project`. */
  readonly lastProjectId: string | null
  readonly teamsKnown: boolean
}

/**
 * The workspace on screen, or null while it is not known yet. A project page
 * and a billing page take the workspace of their project or account, so a
 * link into another workspace switches to it. Until that project or account
 * is known, the answer is null: the page never shows another workspace first.
 */
export function resolveCurrentWorkspaceId(input: CurrentWorkspaceInput): WorkspaceId | null {
  const { scope } = input
  if (scope.kind === "project") {
    const project = input.projects?.find(({ id }) => id === scope.projectId)
    return project ? workspaceIdOfProject(project) : null
  }
  if (scope.kind === "billing") {
    const account = input.billingAccounts?.find(({ id }) => id === scope.accountId)
    return account ? workspaceIdOfBillingAccount(account) : null
  }
  return resolveChosenWorkspaceId(input)
}

function resolveChosenWorkspaceId(input: CurrentWorkspaceInput): WorkspaceId | null {
  if (input.storedId === undefined || input.projects === undefined) return null
  if (input.storedId !== null) {
    if (findWorkspace(input.workspaces, input.storedId)) return input.storedId
    // A team that the person left: Personal, once the teams list confirms it.
    return input.teamsKnown ? PERSONAL_WORKSPACE_ID : null
  }
  // Nothing chosen yet: the workspace of the project opened last.
  const lastProject = input.projects.find(({ id }) => id === input.lastProjectId)
  return lastProject ? workspaceIdOfProject(lastProject) : PERSONAL_WORKSPACE_ID
}

/** Where a switch goes. Null keeps the page and changes only its workspace. */
export type SwitchDestination =
  | { readonly to: "/dashboard/projects/$projectId/project"; readonly params: { projectId: string } }
  | { readonly to: "/dashboard/projects/new" }
  | { readonly to: "/dashboard/billing/$accountId"; readonly params: { accountId: string } }
  | { readonly to: "/dashboard/billing/$accountId/credits"; readonly params: { accountId: string } }
  | null

/** Pages that do not belong to one workspace: they stay as they are after a switch. */
const KEEP_ON_SWITCH = /^\/dashboard\/(?:projects\/new|projects|settings|teams|billing)(?:\/?$|\/)/

/**
 * A switch opens the same billing page of the new workspace, keeps the
 * pages of no workspace (New project, Account settings, Teams), and from a
 * project page lands on the new workspace's last project, else its New
 * project page.
 */
export function switchDestination(input: {
  pathname: string
  target: Workspace
  projects: readonly ProjectDto[]
  lastProjectIdInTarget: string | null
}): SwitchDestination {
  const scope = workspacePageScope(input.pathname)
  const account = input.target.billingAccount
  if (scope.kind === "billing" && account) {
    return scope.page === "plan"
      ? { to: "/dashboard/billing/$accountId", params: { accountId: account.id } }
      : { to: "/dashboard/billing/$accountId/credits", params: { accountId: account.id } }
  }
  if (scope.kind === "chosen" && KEEP_ON_SWITCH.test(input.pathname)) return null
  const projectId = landingProjectIdIn(input.projects, input.target.id, input.lastProjectIdInTarget)
  return projectId
    ? { to: "/dashboard/projects/$projectId/project", params: { projectId } }
    : { to: "/dashboard/projects/new" }
}
