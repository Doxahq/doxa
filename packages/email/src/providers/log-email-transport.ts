import type { EmailAddress } from "../address";
import type { EmailMessage } from "../message";
import { emailSent, type SendEmailResult } from "../send-result";
import type { EmailTransport } from "../transport";

export interface LogEmailTransportOptions {
  readonly write?: (line: string) => void;
  readonly newId?: () => string;
}

export const LOG_PROVIDER = "log";

/**
 * Sends nothing: writes the plain-text email to the log. For local runs and
 * CI where no provider binding exists. Never configure it in production.
 */
export class LogEmailTransport implements EmailTransport {
  readonly provider = LOG_PROVIDER;
  private readonly write: (line: string) => void;
  private readonly newId: () => string;

  constructor(options: LogEmailTransportOptions = {}) {
    this.write = options.write ?? ((line) => console.info(line));
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  async send(message: EmailMessage): Promise<SendEmailResult> {
    const messageId = `log-${this.newId()}`;
    this.write(
      [
        `[email] ${messageId}`,
        `From: ${formatMailbox(message.from)}`,
        `To: ${message.to.map(formatMailbox).join(", ")}`,
        `Subject: ${message.subject}`,
        "",
        message.text,
      ].join("\n"),
    );
    return emailSent(this.provider, messageId);
  }
}

function formatMailbox({ address, name }: EmailAddress): string {
  return name ? `${name} <${address}>` : address;
}
