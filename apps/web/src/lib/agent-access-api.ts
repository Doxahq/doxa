import {
  agentClaimDetailsSchema,
  agentConsentDecisionSchema,
  agentConsentDetailsSchema,
  agentGrantListSchema,
  type AgentClaimDetails,
  type AgentClaimReference,
  type AgentConsentDecision,
  type AgentConsentDetails,
  type AgentGrantList,
  type ApproveAgentClaimInput,
  type ApproveAgentConsentInput,
} from "@doxahq/contracts/agent-access"

import { apiFetch } from "~/lib/platform-api"

function consentPath(consentId: string, action?: "approve" | "deny"): string {
  const base = `/agent-access/consents/${encodeURIComponent(consentId)}`
  return action ? `${base}/${action}` : base
}

/** The pending consent request. Fails with status 404 when it is unknown or expired. */
export async function getAgentConsent(consentId: string): Promise<AgentConsentDetails> {
  const payload = await apiFetch<unknown>(consentPath(consentId))
  return agentConsentDetailsSchema.parse(payload)
}

export async function approveAgentConsent(
  consentId: string,
  input: ApproveAgentConsentInput,
): Promise<AgentConsentDecision> {
  const payload = await apiFetch<unknown>(consentPath(consentId, "approve"), {
    method: "POST",
    json: input,
  })
  return agentConsentDecisionSchema.parse(payload)
}

export async function denyAgentConsent(consentId: string): Promise<AgentConsentDecision> {
  const payload = await apiFetch<unknown>(consentPath(consentId, "deny"), { method: "POST" })
  return agentConsentDecisionSchema.parse(payload)
}

/** Fails with status 404 when the claim is unknown or expired. */
export async function openAgentClaim(reference: AgentClaimReference): Promise<void> {
  await apiFetch<unknown>("/agent-access/claims/open", { method: "POST", json: reference })
}

export async function getAgentClaim(reference: AgentClaimReference): Promise<AgentClaimDetails> {
  const payload = await apiFetch<unknown>("/agent-access/claims/details", { method: "POST", json: reference })
  return agentClaimDetailsSchema.parse(payload)
}

export async function approveAgentClaim(input: ApproveAgentClaimInput): Promise<void> {
  await apiFetch<unknown>("/agent-access/claims/approve", { method: "POST", json: input })
}

export async function denyAgentClaim(reference: AgentClaimReference): Promise<void> {
  await apiFetch<unknown>("/agent-access/claims/deny", { method: "POST", json: reference })
}

export async function listAgentGrants(): Promise<AgentGrantList> {
  const payload = await apiFetch<unknown>("/agent-access/grants")
  return agentGrantListSchema.parse(payload)
}

export async function revokeAgentGrant(grantId: string): Promise<void> {
  await apiFetch<unknown>(`/agent-access/grants/${encodeURIComponent(grantId)}`, {
    method: "DELETE",
  })
}
