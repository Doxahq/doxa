import type { EmailAddress } from "../../address";
import type { EmailMessage } from "../../message";
import { emailFailed, emailSent, type SendEmailResult } from "../../send-result";
import type { EmailTransport } from "../../transport";
import { classifyCloudflareSendError } from "./cloudflare-error-codes";

type CloudflareMailbox = string | { email: string; name: string };

/** The message shape that the `send_email` binding accepts. */
export interface CloudflareEmailBuilder {
  from: CloudflareMailbox;
  to: CloudflareMailbox[];
  cc?: CloudflareMailbox[];
  bcc?: CloudflareMailbox[];
  replyTo?: CloudflareMailbox;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

/**
 * The part of the Workers `SendEmail` binding that this adapter uses. Declared
 * here so the package does not depend on the Workers global types.
 */
export interface CloudflareSendEmailBinding {
  send(message: CloudflareEmailBuilder): Promise<{ messageId: string }>;
}

export const CLOUDFLARE_PROVIDER = "cloudflare";

/**
 * Sends through Cloudflare Email Service with a `send_email` binding.
 * The service has no idempotency key, so `message.idempotencyKey` is not sent.
 */
export class CloudflareEmailTransport implements EmailTransport {
  readonly provider = CLOUDFLARE_PROVIDER;

  constructor(private readonly binding: CloudflareSendEmailBinding) {}

  async send(message: EmailMessage): Promise<SendEmailResult> {
    try {
      const { messageId } = await this.binding.send(toCloudflareBuilder(message));
      return emailSent(this.provider, messageId);
    } catch (error) {
      const failure = classifyCloudflareSendError(error);
      return emailFailed(this.provider, failure.kind, failure.message, failure.code);
    }
  }
}

export function toCloudflareBuilder(message: EmailMessage): CloudflareEmailBuilder {
  return {
    from: toMailbox(message.from),
    to: message.to.map(toMailbox),
    ...(message.cc?.length ? { cc: message.cc.map(toMailbox) } : {}),
    ...(message.bcc?.length ? { bcc: message.bcc.map(toMailbox) } : {}),
    ...(message.replyTo ? { replyTo: toMailbox(message.replyTo) } : {}),
    subject: message.subject,
    html: message.html,
    text: message.text,
    ...(message.headers ? { headers: { ...message.headers } } : {}),
  };
}

function toMailbox({ address, name }: EmailAddress): CloudflareMailbox {
  return name ? { email: address, name } : address;
}
