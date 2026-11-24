import {
  BillingConfigurationError,
  BillingInputError,
  BillingNotConfiguredError,
  BillingNotFoundError,
  BillingStateError,
  CreditsExhaustedError,
  OfferClosedError,
  PAYMENT_FAILED,
  PlanLimitError,
  ProviderRejectedError,
  ProviderUnavailableError,
} from "@doxahq/billing";
import type {
  AiPausedForReviewErrorDetails,
  CreditsExhaustedErrorDetails,
  ModelUnpricedErrorDetails,
  PlanLimitErrorDetails,
} from "@doxahq/contracts/billing";
import { AiAdmissionError } from "../services/billing/generation-metering";
import { error, notFound } from "./response";

export interface BillingErrorLinks {
  /** The dashboard origin (`BILLING_RETURN_BASE_URL`). */
  readonly returnBaseUrl?: string | null;
  /** The account the denial is about, when the route knows it. */
  readonly accountId?: string | null;
  readonly plan?: string | null;
}

function billingPageUrl(links: BillingErrorLinks, accountId: string | null | undefined): string | null {
  if (!links.returnBaseUrl) return null;
  return accountId
    ? `${links.returnBaseUrl}/dashboard/billing/${encodeURIComponent(accountId)}`
    : `${links.returnBaseUrl}/pricing`;
}

/** HTTP 403 `plan_limit` (billing spec 9.3). */
export function planLimitResponse(cause: PlanLimitError, links: BillingErrorLinks = {}): Response {
  const { key, limit, used, resetsAt } = cause.details;
  const details: PlanLimitErrorDetails = {
    code: "plan_limit",
    key,
    limit,
    used,
    plan: links.plan ?? cause.details.plan ?? null,
    resetsAt: resetsAt ? resetsAt.toISOString() : null,
    upgradeUrl: billingPageUrl(links, links.accountId ?? cause.details.accountId),
  };
  return error(cause.message, 403, details);
}

/** HTTP 402 `credits_exhausted` (billing spec 9.3, 10.6). */
export function creditsExhaustedResponse(cause: CreditsExhaustedError, links: BillingErrorLinks = {}): Response {
  const { accountId, available, needed, reason, resetsAt } = cause.details;
  const details: CreditsExhaustedErrorDetails = {
    code: "credits_exhausted",
    accountId,
    available,
    needed,
    reason,
    resetsAt: resetsAt ? resetsAt.toISOString() : null,
    billingUrl: billingPageUrl(links, accountId),
  };
  return error(cause.message, 402, details);
}

/** HTTP 403 `ai_paused_for_review` (billing spec 19) or 503 `model_unpriced` (spec 10.5 step 7). */
export function aiAdmissionResponse(cause: AiAdmissionError): Response {
  if (cause.code === "ai_paused_for_review") {
    const details: AiPausedForReviewErrorDetails = {
      code: "ai_paused_for_review",
      accountId: cause.details.accountId ?? "",
      resetsAt: cause.details.resetsAt ? cause.details.resetsAt.toISOString() : null,
    };
    return error("AI runs of this account are paused for a review. Contact support.", 403, details);
  }
  const details: ModelUnpricedErrorDetails = { code: "model_unpriced", models: [...(cause.details.models ?? [])] };
  return error("AI runs are not available right now. Try again later.", 503, details);
}

/**
 * Maps the billing errors to HTTP answers, or null for any other error.
 * Provider messages stay out of the body: they can carry provider IDs.
 */
export function billingErrorResponse(cause: unknown, links: BillingErrorLinks = {}): Response | null {
  if (cause instanceof PlanLimitError) return planLimitResponse(cause, links);
  if (cause instanceof CreditsExhaustedError) return creditsExhaustedResponse(cause, links);
  if (cause instanceof AiAdmissionError) return aiAdmissionResponse(cause);
  if (cause instanceof BillingInputError) return error(cause.message, 400, { code: cause.code });
  if (cause instanceof BillingNotFoundError) return notFound();
  if (cause instanceof OfferClosedError) {
    return error("The founder offer is full. Check the new price before you continue.", 409, {
      code: cause.code,
      offer: cause.offerKey,
      price: cause.newPriceKey,
    });
  }
  if (cause instanceof BillingStateError) return error(cause.message, 409, { code: cause.code });
  if (cause instanceof BillingNotConfiguredError || cause instanceof BillingConfigurationError) {
    return error("Billing is not configured on this server.", 503, { code: "billing_not_configured" });
  }
  if (cause instanceof ProviderUnavailableError) {
    return error("The payment provider is not available. Try again in a minute.", 503, { code: "provider_unavailable" });
  }
  if (cause instanceof ProviderRejectedError && cause.providerCode === PAYMENT_FAILED) {
    return error("The card was declined. Update the payment method and try again.", 402, { code: "payment_failed" });
  }
  if (cause instanceof ProviderRejectedError) {
    return error("The payment provider refused the request.", 502, { code: "provider_rejected" });
  }
  return null;
}
