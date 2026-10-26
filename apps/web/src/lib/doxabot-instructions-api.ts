import {
  doxabotInstructionsStateSchema,
  type DoxabotInstructionsState,
  type RestoreDoxabotInstructionsInput,
  type SaveDoxabotInstructionsInput,
} from "@doxahq/contracts/doxabot-instructions"

import { apiFetch } from "~/lib/platform-api"

function instructionsPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/doxabot/instructions`
}

export async function getDoxabotInstructions(projectId: string): Promise<DoxabotInstructionsState> {
  return doxabotInstructionsStateSchema.parse(await apiFetch<unknown>(instructionsPath(projectId)))
}

/** Fails with 403 without `instructions.configure`, and with 409 when someone saved newer instructions. */
export async function saveDoxabotInstructions(
  projectId: string,
  input: SaveDoxabotInstructionsInput,
): Promise<DoxabotInstructionsState> {
  const payload = await apiFetch<unknown>(instructionsPath(projectId), { method: "PUT", json: input })
  return doxabotInstructionsStateSchema.parse(payload)
}

export async function restoreDoxabotInstructions(
  projectId: string,
  input: RestoreDoxabotInstructionsInput,
): Promise<DoxabotInstructionsState> {
  const payload = await apiFetch<unknown>(`${instructionsPath(projectId)}/restore`, { method: "POST", json: input })
  return doxabotInstructionsStateSchema.parse(payload)
}
