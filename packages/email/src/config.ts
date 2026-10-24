import { parseEmailAddress, type EmailAddress } from "./address";
import type { EmailStream } from "./catalog/define-email-kind";
import type { CloudflareSendEmailBinding } from "./providers/cloudflare/cloudflare-email-transport";

/**
 * The Worker bindings and variables that configure email. A Worker `Env`
 * extends this interface. A new provider or a new stream adds its fields here.
 */
export interface EmailEnv {
  /** A provider name from `EMAIL_PROVIDERS`, such as `cloudflare` or `log`. */
  EMAIL_PROVIDER?: string;
  /** Sender of the `transactional` stream (invites), for example `Doxa <no-reply@notification.doxa.so>`. */
  EMAIL_FROM_TRANSACTIONAL?: string;
  /** Sender of the `notifications` stream, for example `Doxa <no-reply@notification.doxa.so>`. */
  EMAIL_FROM_NOTIFICATIONS?: string;
  /** Optional reply address for every stream. */
  EMAIL_REPLY_TO?: string;
  /** The Cloudflare `send_email` binding, used by the `cloudflare` provider. */
  EMAIL?: CloudflareSendEmailBinding;
}

/** The sender setting of each stream. The compiler fails when a stream has none. */
const SENDER_SETTINGS = {
  transactional: "EMAIL_FROM_TRANSACTIONAL",
  notifications: "EMAIL_FROM_NOTIFICATIONS",
} as const satisfies Record<EmailStream, keyof EmailEnv>;

/** Thrown at startup for a missing or wrong email setting, never during a send. */
export class EmailConfigurationError extends Error {
  override readonly name = "EmailConfigurationError";
}

export interface SenderDefaults {
  readonly from: EmailAddress;
  readonly replyTo?: EmailAddress;
}

export type EmailSenders = Readonly<Record<EmailStream, SenderDefaults>>;

/** Reads one sender for each stream. Every stream must be set, so a missing one fails at startup. */
export function readSenders(
  env: Pick<EmailEnv, (typeof SENDER_SETTINGS)[EmailStream] | "EMAIL_REPLY_TO">,
): EmailSenders {
  const replyToValue = env.EMAIL_REPLY_TO?.trim();
  const replyTo = replyToValue ? parseSetting(replyToValue, "EMAIL_REPLY_TO") : undefined;
  const senderOf = (stream: EmailStream): SenderDefaults => {
    const name = SENDER_SETTINGS[stream];
    return {
      from: parseSetting(requireSetting(env[name], name), name),
      ...(replyTo ? { replyTo } : {}),
    };
  };
  return { transactional: senderOf("transactional"), notifications: senderOf("notifications") };
}

export function requireSetting<T>(value: T | undefined, name: string): T {
  if (value === undefined || (typeof value === "string" && value.trim() === "")) {
    throw new EmailConfigurationError(`Email is not configured: set ${name}.`);
  }
  return value;
}

function parseSetting(value: string, name: string): EmailAddress {
  try {
    return parseEmailAddress(value);
  } catch {
    throw new EmailConfigurationError(`${name} is not one valid email address.`);
  }
}
