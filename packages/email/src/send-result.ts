/**
 * Why a send failed, in terms that do not depend on the provider. Each adapter
 * maps its own error codes to one of these kinds.
 */
export type EmailFailureKind =
  /** The message breaks a rule (size, headers, fields). Fix the code; do not retry. */
  | "invalid_message"
  /** The sender, domain or binding is not set up. Fix the configuration; do not retry. */
  | "configuration"
  /** The provider will not send to this recipient after a bounce or a complaint. */
  | "recipient_suppressed"
  /** The receiving server refused the email. */
  | "rejected"
  /** Too many sends in a short time. Retry later. */
  | "rate_limited"
  /** The daily or monthly sending quota is used up. Retry after the quota resets. */
  | "quota_exceeded"
  /** The provider or the network failed. Retry later. */
  | "unavailable";

const RETRYABLE_FAILURE_KINDS: Readonly<Record<EmailFailureKind, boolean>> = {
  invalid_message: false,
  configuration: false,
  recipient_suppressed: false,
  rejected: false,
  rate_limited: true,
  quota_exceeded: true,
  unavailable: true,
};

export interface EmailSent {
  readonly ok: true;
  readonly provider: string;
  /** The provider's ID for the accepted email. */
  readonly messageId: string;
}

export interface EmailFailure {
  readonly ok: false;
  readonly provider: string;
  readonly kind: EmailFailureKind;
  /** True when the same message can succeed later without a change. */
  readonly retryable: boolean;
  readonly message: string;
  /** The provider's own error code, kept for logs and support. */
  readonly providerCode?: string;
}

export type SendEmailResult = EmailSent | EmailFailure;

export function emailSent(provider: string, messageId: string): EmailSent {
  return { ok: true, provider, messageId };
}

export function emailFailed(
  provider: string,
  kind: EmailFailureKind,
  message: string,
  providerCode?: string,
): EmailFailure {
  return {
    ok: false,
    provider,
    kind,
    retryable: RETRYABLE_FAILURE_KINDS[kind],
    message,
    ...(providerCode ? { providerCode } : {}),
  };
}
