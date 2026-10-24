import type { SendEmailResult } from "../send-result";

/** The body of one message on the email queue. The row holds everything else. */
export interface EmailQueueMessage {
  readonly deliveryId: string;
}

/** A delivery that the `doxa-email` Worker now owns until it records the attempt. */
export interface ClaimedEmailDelivery {
  readonly id: string;
  readonly kind: string;
  /** Untrusted: the Worker checks them with the kind's schema before the render. */
  readonly props: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly recipientEmail: string;
  readonly claimToken: string;
  /** This attempt's number, counted from 1. */
  readonly attempt: number;
}

export interface EmailAttempt {
  readonly deliveryId: string;
  readonly claimToken: string;
  readonly attempt: number;
  readonly result: SendEmailResult;
}

/** `retryAfterSeconds` is set when the Worker must retry the queue message; otherwise it acknowledges it. */
export interface EmailAttemptOutcome {
  readonly retryAfterSeconds: number | null;
}

/**
 * The RPC that `doxa-api` exposes to `doxa-email`. The API owns the database;
 * the email Worker owns rendering and the provider binding.
 */
export interface EmailDeliveryRpc {
  /** Returns `null` when the row is gone, already claimed, finished, or suppressed. */
  claimEmailDelivery(deliveryId: string): Promise<ClaimedEmailDelivery | null>;
  /** Records the attempt. A lost claim (the sweeper took the row back) gives no retry. */
  recordEmailAttempt(attempt: EmailAttempt): Promise<EmailAttemptOutcome>;
}
