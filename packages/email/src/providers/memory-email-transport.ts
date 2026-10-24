import type { EmailMessage } from "../message";
import { emailFailed, emailSent, type EmailFailureKind, type SendEmailResult } from "../send-result";
import type { EmailTransport } from "../transport";

export const MEMORY_PROVIDER = "memory";

/** Keeps every message in memory. Tests can queue failures for the next sends. */
export class MemoryEmailTransport implements EmailTransport {
  readonly provider = MEMORY_PROVIDER;
  private readonly delivered: EmailMessage[] = [];
  private readonly queuedFailures: EmailFailureKind[] = [];

  get sent(): readonly EmailMessage[] {
    return this.delivered;
  }

  /** The next send fails with `kind`. Call it again to queue more failures. */
  failNextWith(kind: EmailFailureKind): void {
    this.queuedFailures.push(kind);
  }

  async send(message: EmailMessage): Promise<SendEmailResult> {
    const failure = this.queuedFailures.shift();
    if (failure) return emailFailed(this.provider, failure, `Queued test failure: ${failure}.`);
    this.delivered.push(message);
    return emailSent(this.provider, `memory-${this.delivered.length}`);
  }
}
