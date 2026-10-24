import type { ClaimedEmailDelivery, EmailFailureKind, FinalDeliveryStatus, SuppressionReason } from "@doxahq/email";
import type { EmailNotificationCategory } from "@doxahq/email/catalog";

export interface NewEmailDelivery {
  readonly kind: string;
  readonly props: unknown;
  readonly headers: Readonly<Record<string, string>>;
  /** Lowercase. */
  readonly recipientEmail: string;
  readonly recipientUserId: string | null;
  readonly dedupeKey: string;
}

export interface DeliveryFailure {
  readonly kind: EmailFailureKind;
  readonly message: string;
  readonly providerCode?: string;
}

export type DeliveryUpdate =
  | {
      readonly status: Extract<FinalDeliveryStatus, "sent">;
      readonly provider: string;
      readonly providerMessageId: string;
    }
  | {
      readonly status: Exclude<FinalDeliveryStatus, "sent">;
      readonly provider: string;
      readonly failure: DeliveryFailure;
    }
  | {
      readonly status: "queued";
      readonly provider: string;
      readonly failure: DeliveryFailure;
      readonly retryAt: Date;
    };

/** The outbox table (`email_deliveries`). */
export interface EmailDeliveryStore {
  /** Returns the new ID, or `null` when a delivery with the same dedupe key exists. */
  insert(delivery: NewEmailDelivery): Promise<string | null>;
  /** Moves a `queued` row to `sending` with a new claim token. Returns `null` for any other row. */
  claim(id: string, now: Date): Promise<ClaimedEmailDelivery | null>;
  /**
   * Applies the update only while the claim token still owns the row.
   * Returns the recipient, or `null` when the claim was lost.
   */
  complete(id: string, claimToken: string, update: DeliveryUpdate, now: Date): Promise<string | null>;
  /**
   * Returns the IDs to send to the queue again: `queued` rows due for longer
   * than `queuedGraceMs`, and `sending` rows older than `sendingTimeoutMs`
   * (set back to `queued`). Each returned row gets `next_attempt_at = now`.
   */
  takeStale(now: Date, limits: StaleLimits): Promise<string[]>;
}

export interface StaleLimits {
  readonly queuedGraceMs: number;
  readonly sendingTimeoutMs: number;
  readonly batchSize: number;
}

/** Addresses that Doxa does not send to (`email_suppressions`). */
export interface EmailSuppressionStore {
  isSuppressed(email: string): Promise<boolean>;
  /** Keeps the first reason when the address is already listed. */
  suppress(entries: readonly { email: string; reason: SuppressionReason; source: string }[]): Promise<number>;
}

/** Notification switches (`email_preferences`). A missing row means on. */
export interface EmailPreferencesStore {
  disabledCategories(userId: string): Promise<ReadonlySet<EmailNotificationCategory>>;
  set(userId: string, category: EmailNotificationCategory, enabled: boolean, now: Date): Promise<void>;
}
