import {
  projectApprovalSettingsSchema,
  userApprovalSettingsSchema,
  type ProjectApprovalSettings,
  type UpdateProjectApprovalSettingsInput,
  type UpdateUserApprovalSettingsInput,
  type UserApprovalSettings,
} from "@doxahq/contracts/approval-settings"

import { apiFetch } from "~/lib/platform-api"

const USER_PATH = "/approval-settings"

function projectPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/approval-settings`
}

export async function getProjectApprovalSettings(projectId: string): Promise<ProjectApprovalSettings> {
  return projectApprovalSettingsSchema.parse(await apiFetch<unknown>(projectPath(projectId)))
}

/** Fails with status 403 when the user lacks `approvals.configure`. */
export async function updateProjectApprovalSettings(
  projectId: string,
  input: UpdateProjectApprovalSettingsInput,
): Promise<ProjectApprovalSettings> {
  const payload = await apiFetch<unknown>(projectPath(projectId), { method: "PUT", json: input })
  return projectApprovalSettingsSchema.parse(payload)
}

export async function getUserApprovalSettings(): Promise<UserApprovalSettings> {
  return userApprovalSettingsSchema.parse(await apiFetch<unknown>(USER_PATH))
}

export async function updateUserApprovalSettings(input: UpdateUserApprovalSettingsInput): Promise<UserApprovalSettings> {
  return userApprovalSettingsSchema.parse(await apiFetch<unknown>(USER_PATH, { method: "PUT", json: input }))
}
