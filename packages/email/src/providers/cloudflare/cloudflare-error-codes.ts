import type { EmailFailureKind } from "../../send-result";

/**
 * Error codes of the Workers `send_email` binding.
 * Source: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 */
const FAILURE_KIND_BY_CODE: Readonly<Record<string, EmailFailureKind>> = {
  E_VALIDATION_ERROR: "invalid_message",
  E_FIELD_MISSING: "invalid_message",
  E_TOO_MANY_RECIPIENTS: "invalid_message",
  E_TOO_MANY_ATTACHMENTS: "invalid_message",
  E_CONTENT_TOO_LARGE: "invalid_message",
  E_HEADER_NOT_ALLOWED: "invalid_message",
  E_HEADER_USE_API_FIELD: "invalid_message",
  E_HEADER_VALUE_INVALID: "invalid_message",
  E_HEADER_VALUE_TOO_LONG: "invalid_message",
  E_HEADER_NAME_INVALID: "invalid_message",
  E_HEADERS_TOO_LARGE: "invalid_message",
  E_HEADERS_TOO_MANY: "invalid_message",
  E_SENDER_NOT_VERIFIED: "configuration",
  E_SENDER_DOMAIN_NOT_AVAILABLE: "configuration",
  E_RECIPIENT_NOT_ALLOWED: "configuration",
  E_RECIPIENT_SUPPRESSED: "recipient_suppressed",
  E_DELIVERY_FAILED: "rejected",
  E_RATE_LIMIT_EXCEEDED: "rate_limited",
  E_DAILY_LIMIT_EXCEEDED: "quota_exceeded",
  E_INTERNAL_SERVER_ERROR: "unavailable",
};

export interface CloudflareSendError {
  readonly kind: EmailFailureKind;
  readonly message: string;
  readonly code?: string;
}

/** An unknown code or a thrown value without a code counts as a temporary outage. */
export function classifyCloudflareSendError(error: unknown): CloudflareSendError {
  const code = readStringField(error, "code");
  const message = readStringField(error, "message") ?? "Cloudflare Email Service did not accept the email.";
  const kind = (code && FAILURE_KIND_BY_CODE[code]) || "unavailable";
  return { kind, message, ...(code ? { code } : {}) };
}

function readStringField(value: unknown, field: "code" | "message"): string | undefined {
  if (typeof value !== "object" || value === null || !(field in value)) return undefined;
  const fieldValue: unknown = Reflect.get(value, field);
  return typeof fieldValue === "string" && fieldValue.length > 0 ? fieldValue : undefined;
}
