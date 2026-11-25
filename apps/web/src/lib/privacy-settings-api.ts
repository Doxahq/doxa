import {
  privacySettingsSchema,
  type PrivacySettings,
  type UpdatePrivacySettingsInput,
} from "@doxahq/contracts/privacy-settings"

import { apiFetch } from "~/lib/platform-api"

const PRIVACY_SETTINGS_PATH = "/privacy-settings"

export async function getPrivacySettings(): Promise<PrivacySettings> {
  return privacySettingsSchema.parse(await apiFetch<unknown>(PRIVACY_SETTINGS_PATH))
}

export async function updatePrivacySettings(input: UpdatePrivacySettingsInput): Promise<PrivacySettings> {
  return privacySettingsSchema.parse(await apiFetch<unknown>(PRIVACY_SETTINGS_PATH, { method: "PUT", json: input }))
}
