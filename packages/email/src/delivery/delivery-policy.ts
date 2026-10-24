import type { EmailFailureKind, SendEmailResult } from "../send-result";

/** The final states of one delivery. `queued` and `sending` are the other, transient states. */
export type FinalDeliveryStatus = "sent" | "failed" | "suppressed";

export type DeliveryDecision =
  | { readonly action: "complete"; readonly status: FinalDeliveryStatus }
  | { readonly action: "retry"; readonly delaySeconds: number };

type RetryableKind = Extract<EmailFailureKind, "rate_limited" | "quota_exceeded" | "unavailable">;

interface RetryRule {
  readonly maxAttempts: number;
  /** Delay before attempt `attempt + 1`, for an attempt counted from 1. */
  delaySeconds(attempt: number): number;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/**
 * One retry rule for each retryable failure kind (spec §6.2). The rules use
 * provider-neutral kinds, so they stay the same after a provider swap.
 */
export const DELIVERY_RETRY_RULES: Readonly<Record<RetryableKind, RetryRule>> = {
  rate_limited: { maxAttempts: 8, delaySeconds: () => MINUTE },
  unavailable: { maxAttempts: 8, delaySeconds: (attempt) => Math.min(30 * 2 ** (attempt - 1), HOUR) },
  quota_exceeded: { maxAttempts: 24, delaySeconds: () => HOUR },
};

/** Decides what happens to a delivery after attempt number `attempt` (counted from 1). */
export function decideDelivery(result: SendEmailResult, attempt: number): DeliveryDecision {
  if (result.ok) return { action: "complete", status: "sent" };
  if (result.kind === "recipient_suppressed") return { action: "complete", status: "suppressed" };
  if (!isRetryableKind(result.kind)) return { action: "complete", status: "failed" };

  const rule = DELIVERY_RETRY_RULES[result.kind];
  if (attempt >= rule.maxAttempts) return { action: "complete", status: "failed" };
  return { action: "retry", delaySeconds: rule.delaySeconds(attempt) };
}

function isRetryableKind(kind: EmailFailureKind): kind is RetryableKind {
  return Object.hasOwn(DELIVERY_RETRY_RULES, kind);
}
