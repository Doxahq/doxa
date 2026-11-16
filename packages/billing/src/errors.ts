/**
 * Errors of the provider-neutral core. Provider errors live in
 * `provider/errors.ts`; the configuration error lives in `config.ts`.
 */

/** A caller sent a value that billing refuses (an unknown outcome, a cap out of range). HTTP 400. */
export class BillingInputError extends Error {
  override readonly name = "BillingInputError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The reasons of a `credits_exhausted` answer (spec 10.6). */
export type CreditsExhaustedReason = "trial_credits" | "max_debt" | "monthly_limit" | "past_due" | "payg_off";

/** HTTP 402 `credits_exhausted`. */
export class CreditsExhaustedError extends Error {
  override readonly name = "CreditsExhaustedError";
  readonly code = "credits_exhausted" as const;
  constructor(
    readonly details: {
      readonly accountId: string;
      readonly available: number;
      readonly needed: number;
      readonly reason: CreditsExhaustedReason;
      readonly resetsAt: Date | null;
    },
  ) {
    super(`The account has ${details.available} credits available and needs ${details.needed} (${details.reason}).`);
  }
}

/** HTTP 403 `plan_limit`: a feature is off or a limit is reached. */
export class PlanLimitError extends Error {
  override readonly name = "PlanLimitError";
  readonly code = "plan_limit" as const;
  constructor(
    readonly details: {
      readonly key: string;
      readonly limit: number | "unlimited" | boolean;
      readonly used: number | null;
      readonly reason?: string;
      readonly resetsAt?: Date | null;
    },
  ) {
    super(`Plan limit reached for ${details.key}.`);
  }
}

/** HTTP 409 `offer_closed`: the founder offer filled while the customer looked. Carries the new price. */
export class OfferClosedError extends Error {
  override readonly name = "OfferClosedError";
  readonly code = "offer_closed" as const;
  constructor(
    readonly offerKey: string,
    readonly newPriceKey: string,
  ) {
    super(`Offer ${offerKey} is full. The price is now ${newPriceKey}.`);
  }
}

/** A stored row is not in the state that an operation needs (for example settle on a released hold). */
export class BillingStateError extends Error {
  override readonly name = "BillingStateError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * `BillingStateError` code: another admission of the same subject still holds
 * credits. A subject has at most one held reservation, so two continues of
 * one job cannot both run, and usage always has one hold to go to.
 */
export const RESERVATION_IN_USE = "reservation_in_use";

/** The account or another record does not exist. */
export class BillingNotFoundError extends Error {
  override readonly name: string = "BillingNotFoundError";
}

/**
 * A provider customer that Doxa did not make: no billing account links it, and it
 * has no Doxa account in its metadata. For example a customer made by hand in the
 * Stripe dashboard. A webhook about it is not Doxa's to process.
 */
export class BillingUnknownCustomerError extends BillingNotFoundError {
  override readonly name: string = "BillingUnknownCustomerError";
}
