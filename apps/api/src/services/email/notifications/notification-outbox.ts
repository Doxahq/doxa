import type { EmailKind } from "@doxahq/email/catalog";
import type { EmailContact } from "../../../repositories/email-audience";
import type { EmailLog } from "../email-log";
import type { EmailOutbox, ProducerProps } from "../email-outbox";

/**
 * Sends notification emails for the notifiers. A notification is a side
 * effect: a failure is logged and never reaches the action that caused it.
 */
export class NotificationOutbox {
  constructor(
    private readonly outbox: Pick<EmailOutbox, "enqueue">,
    private readonly log: EmailLog,
  ) {}

  /** One email for each contact, each with its own dedupe key. */
  async notify<Kind extends EmailKind>(
    kind: Kind,
    contacts: readonly EmailContact[],
    propsFor: (contact: EmailContact) => ProducerProps<Kind>,
    dedupeKeyFor: (contact: EmailContact) => string,
  ): Promise<void> {
    for (const contact of contacts) {
      await this.outbox.enqueue(kind, propsFor(contact), { email: contact.email, userId: contact.userId }, dedupeKeyFor(contact));
    }
  }

  /** Runs `work` and logs a failure instead of throwing it. */
  async safely(event: string, subjectId: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.log("email_notification_failed", {
        notification: event,
        subjectId,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}
