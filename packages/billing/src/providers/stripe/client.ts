import Stripe from "stripe";

import { ProviderRejectedError, ProviderUnavailableError } from "../../provider/errors";

/**
 * The one Stripe API version that Doxa speaks (spec 6.3). A change is a code
 * change with tests, never a setting.
 *
 * Managed Payments needs `2025-03-31.basil` or later (spec 10.10 sandbox
 * results). This is the version that the `stripe` SDK 23.1.0 pins, so the SDK
 * types describe exactly what the API sends. The D2 sandbox test ran on
 * `2026-04-22.dahlia`; the Endive breaking changes (2026-09-30) touch none of
 * the fields Doxa uses (see the Stripe changelog: `payment_method_types` on
 * Checkout, which Doxa never sends; the polymorphic billing cycle anchor
 * parameter, which Doxa never sets).
 *
 * The webhook endpoint must use the same version (`api_version` on the
 * endpoint), so event payloads have the shapes the mapper reads.
 */
export const STRIPE_API_VERSION = "2026-10-28.endive" as const satisfies typeof Stripe.API_VERSION;

export type StripeClient = Stripe;

export interface StripeClientOptions {
  readonly secretKey: string;
  /** Tests pass a fake HTTP layer (`Stripe.createFetchHttpClient(fakeFetch)`). Production uses the SDK's Node client. */
  readonly httpClient?: ReturnType<typeof Stripe.createFetchHttpClient>;
  /** Network retries inside the SDK. Every create call carries our own idempotency key, so a retry is safe. */
  readonly maxNetworkRetries?: number;
  readonly timeoutMs?: number;
}

export function createStripeClient(options: StripeClientOptions): StripeClient {
  return new Stripe(options.secretKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: options.maxNetworkRetries ?? 2,
    timeout: options.timeoutMs ?? 20_000,
    typescript: true,
    appInfo: { name: "doxa-billing" },
    ...(options.httpClient ? { httpClient: options.httpClient } : {}),
  });
}

/** Stripe's answer to a second meter event with the same `identifier` (spec 10.10 sandbox results). */
const DUPLICATE_METER_EVENT = /an event already exists with identifier/i;

export function isDuplicateMeterEventError(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeError && DUPLICATE_METER_EVENT.test(error.message);
}

/**
 * Turns an SDK error into a provider error (spec 12): feature code never sees
 * a Stripe error. Network faults, rate limits and Stripe 5xx are retryable;
 * everything else is a refusal. Messages carry no secrets: Stripe errors name
 * the parameter, never the key.
 */
export function toProviderError(error: unknown, operation: string): Error {
  if (error instanceof ProviderRejectedError || error instanceof ProviderUnavailableError) return error;
  if (error instanceof Stripe.errors.StripeError) {
    const message = `Stripe ${operation}: ${error.message}`;
    const retryable =
      error instanceof Stripe.errors.StripeConnectionError ||
      error instanceof Stripe.errors.StripeAPIError ||
      error instanceof Stripe.errors.StripeRateLimitError ||
      (error.statusCode !== undefined && error.statusCode >= 500);
    if (retryable) return new ProviderUnavailableError(message, { cause: error });
    return new ProviderRejectedError(message, error.code ?? error.type ?? null, { cause: error });
  }
  const text = error instanceof Error ? error.message : String(error);
  return new ProviderUnavailableError(`Stripe ${operation}: ${text}`, { cause: error });
}

/** Runs one SDK call and maps its errors. */
export async function callStripe<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toProviderError(error, operation);
  }
}
