import { AGENT_USER_CODE_LENGTH } from "@doxahq/contracts/agent-access"

/** Keeps only digits, so that a pasted "123 456" still works. */
export function normalizeUserCode(value: string): string {
  return value.replace(/\D/g, "").slice(0, AGENT_USER_CODE_LENGTH)
}

export function isCompleteUserCode(value: string): boolean {
  return value.length === AGENT_USER_CODE_LENGTH
}

export function claimReturnPath(attemptToken: string): string {
  return `/oauth/claim?attempt=${encodeURIComponent(attemptToken)}`
}
