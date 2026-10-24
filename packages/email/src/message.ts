import { z } from "zod";
import { emailAddressSchema, type EmailAddress } from "./address";

/**
 * Limits that every supported provider accepts. They are the strictest values
 * of Cloudflare Email Service, Amazon SES and Resend, so a provider swap never
 * turns a valid message into a rejected one.
 */
export const EMAIL_MESSAGE_LIMITS = {
  recipients: 50,
  subjectLength: 998,
  headerNameLength: 100,
  headerValueBytes: 2048,
  idempotencyKeyLength: 256,
} as const;

/** One email, independent of the provider that sends it. */
export interface EmailMessage {
  readonly from: EmailAddress;
  readonly to: readonly EmailAddress[];
  readonly cc?: readonly EmailAddress[];
  readonly bcc?: readonly EmailAddress[];
  readonly replyTo?: EmailAddress;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** Custom headers. Use `X-` names or a header that every provider allows, such as `List-Unsubscribe`. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * A stable key for one logical email, such as an outbox delivery ID.
   * Providers with idempotency support use it. The others ignore it.
   */
  readonly idempotencyKey?: string;
}

/** Letters, digits and dashes: valid for every provider (Cloudflare refuses `_` outside `X-` headers). */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;
const LINE_BREAK_PATTERN = /[\r\n]/;

const headerValueSchema = z
  .string()
  .min(1)
  .refine((value) => !LINE_BREAK_PATTERN.test(value), "A header value cannot contain a line break.")
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= EMAIL_MESSAGE_LIMITS.headerValueBytes,
    `A header value cannot be longer than ${EMAIL_MESSAGE_LIMITS.headerValueBytes} bytes.`,
  );

const emailMessageSchema = z
  .object({
    from: emailAddressSchema,
    to: z.array(emailAddressSchema).min(1),
    cc: z.array(emailAddressSchema).optional(),
    bcc: z.array(emailAddressSchema).optional(),
    replyTo: emailAddressSchema.optional(),
    subject: z
      .string()
      .trim()
      .min(1)
      .max(EMAIL_MESSAGE_LIMITS.subjectLength)
      .refine((subject) => !LINE_BREAK_PATTERN.test(subject), "The subject cannot contain a line break."),
    html: z.string().min(1),
    text: z.string().min(1),
    headers: z
      .record(
        z.string().max(EMAIL_MESSAGE_LIMITS.headerNameLength).regex(HEADER_NAME_PATTERN),
        headerValueSchema,
      )
      .optional(),
    idempotencyKey: z.string().min(1).max(EMAIL_MESSAGE_LIMITS.idempotencyKeyLength).optional(),
  })
  .refine(
    (message) => recipientCount(message) <= EMAIL_MESSAGE_LIMITS.recipients,
    `An email cannot have more than ${EMAIL_MESSAGE_LIMITS.recipients} recipients across to, cc and bcc.`,
  );

/** Returns why the message is not valid for every provider, or `null` when it is valid. */
export function findEmailMessageProblem(message: EmailMessage): string | null {
  const result = emailMessageSchema.safeParse(message);
  if (result.success) return null;
  const issue = result.error.issues[0];
  const path = issue?.path.join(".");
  return path ? `${path}: ${issue?.message}` : (issue?.message ?? "The email is not valid.");
}

function recipientCount(message: Pick<EmailMessage, "to" | "cc" | "bcc">): number {
  return message.to.length + (message.cc?.length ?? 0) + (message.bcc?.length ?? 0);
}
