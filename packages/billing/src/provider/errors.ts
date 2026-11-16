/** Provider errors (spec section 12). Feature code sees only these, never a provider SDK error. */

/** The provider is down or timed out. Retry later. */
export class ProviderUnavailableError extends Error {
  override readonly name = "ProviderUnavailableError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** The provider refused the request (bad input, a state it does not allow). Do not retry. */
export class ProviderRejectedError extends Error {
  override readonly name = "ProviderRejectedError";
  constructor(
    message: string,
    readonly providerCode: string | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** `ProviderRejectedError.providerCode` of a payment that the card refused (Start Pro now). */
export const PAYMENT_FAILED = "payment_failed";
/** `ProviderRejectedError.providerCode` of a trial end on a subscription that is not trialing. */
export const NOT_TRIALING = "not_trialing";

/** A webhook signature is missing, wrong or too old. The webhook route answers 400 and stores nothing. */
export class ProviderSignatureError extends Error {
  override readonly name = "ProviderSignatureError";
}

/** The `none` provider: this install takes no payments (`billing_not_configured`). */
export class BillingNotConfiguredError extends Error {
  override readonly name = "BillingNotConfiguredError";
  readonly code = "billing_not_configured" as const;
  constructor(operation: string) {
    super(`Billing is not configured on this install: ${operation} needs a payment provider.`);
  }
}
