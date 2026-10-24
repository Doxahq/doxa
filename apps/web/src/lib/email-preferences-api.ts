import {
  emailPreferencesSchema,
  emailUnsubscribeResultSchema,
  type EmailPreferences,
  type EmailUnsubscribeResult,
  type UpdateEmailPreferenceInput,
} from "@doxahq/contracts/email-preferences"

import { apiFetch } from "~/lib/platform-api"

const PREFERENCES_PATH = "/email-preferences"

export async function getEmailPreferences(): Promise<EmailPreferences> {
  return emailPreferencesSchema.parse(await apiFetch<unknown>(PREFERENCES_PATH))
}

export async function updateEmailPreference(input: UpdateEmailPreferenceInput): Promise<EmailPreferences> {
  return emailPreferencesSchema.parse(await apiFetch<unknown>(PREFERENCES_PATH, { method: "PUT", json: input }))
}

/** Sends the signed query of an unsubscribe link. It needs no session. */
export async function unsubscribeByLink(link: { user: string; category: string; token: string }): Promise<EmailUnsubscribeResult> {
  const query = new URLSearchParams(link)
  const payload = await apiFetch<unknown>(`/email/unsubscribe?${query.toString()}`, { method: "POST" })
  return emailUnsubscribeResultSchema.parse(payload)
}
