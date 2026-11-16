import { CreditsExhaustedError, PlanLimitError } from "@doxahq/billing";
import type { BillingRefusal } from "../billing/generation-metering";
import { ActionExecutionError } from "./errors";

/**
 * Billing spec 10.6 and 15.3: an agent gets the same facts as the dashboard,
 * in the message, because the actions RPC carries only a code and a message.
 */
export function billingRefusalActionError(cause: BillingRefusal): ActionExecutionError {
  if (cause instanceof CreditsExhaustedError) {
    const { available, needed, reason, resetsAt } = cause.details;
    const reset = resetsAt ? ` Credits reset at ${resetsAt.toISOString()}.` : "";
    return new ActionExecutionError(
      "credits_exhausted",
      `Not enough AI credits: ${available} available, ${needed} needed (reason: ${reason}).${reset} Manage billing in the Doxa dashboard.`,
    );
  }
  if (cause instanceof PlanLimitError) {
    const reason = cause.details.reason ? ` (${cause.details.reason})` : "";
    return new ActionExecutionError(
      "plan_limit",
      `The account's plan does not include ${cause.details.key}${reason}. Upgrade the plan in the Doxa dashboard.`,
    );
  }
  return new ActionExecutionError(cause.code, cause.message);
}
