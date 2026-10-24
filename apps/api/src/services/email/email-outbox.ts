import {
  isNotificationCategory,
  type EmailKind,
  type EmailKindProps,
  type EmailNotificationCategory,
} from "@doxahq/email/catalog";
import { UnsubscribeTokens, unsubscribeHeaders, type EmailQueueMessage } from "@doxahq/email";
import type { Env } from "../../env";
import { EmailDeliveriesRepository, EmailPreferencesRepository } from "../../repositories/email-deliveries";
import type { EmailDeliveryStore, EmailPreferencesStore } from "./email-delivery-store";
import { dashboardLinks, emailLinksFromEnv, type EmailLinks } from "./email-links";
import { consoleEmailLog, type EmailLog } from "./email-log";

/** The part of a Cloudflare `Queue` that the email outbox uses. */
export interface EmailQueueProducer {
  send(message: EmailQueueMessage): Promise<unknown>;
  sendBatch(messages: Iterable<{ body: EmailQueueMessage }>): Promise<unknown>;
}

/** Props that a producer gives. The outbox adds the unsubscribe link of each notification. */
export type ProducerProps<Kind extends EmailKind> = Omit<EmailKindProps<Kind>, "unsubscribeUrl">;

export interface EmailRecipient {
  readonly email: string;
  /** Required for notification kinds: preferences and unsubscribe links belong to a user. */
  readonly userId: string | null;
}

export type EnqueueOutcome = "queued" | "duplicate" | "opted_out";

export interface EmailOutboxDeps {
  readonly deliveries: Pick<EmailDeliveryStore, "insert">;
  readonly preferences: Pick<EmailPreferencesStore, "disabledCategories">;
  /** Missing in a Worker without the email queue: the row then waits for the sweeper. */
  readonly queue: EmailQueueProducer | undefined;
  readonly unsubscribe: UnsubscribeTokens;
  readonly links: EmailLinks;
  readonly log: EmailLog;
}

/**
 * The producer side of the email pipeline (email spec §9.2). It checks the
 * props, records the delivery, and sends its ID to the email queue. It loads
 * no React: rendering happens in the `doxa-email` Worker.
 */
export class EmailOutbox {
  constructor(private readonly deps: EmailOutboxDeps) {}

  static fromEnv(env: Env): EmailOutbox {
    return new EmailOutbox({
      deliveries: EmailDeliveriesRepository.fromEnv(env),
      preferences: EmailPreferencesRepository.fromEnv(env),
      queue: env.EMAIL_QUEUE,
      unsubscribe: unsubscribeTokensFromEnv(env),
      links: emailLinksFromEnv(env),
      log: consoleEmailLog,
    });
  }

  get links(): EmailLinks {
    return this.deps.links;
  }

  /**
   * Queues one email. A second call with the same `dedupeKey` does nothing.
   * Throws for props that do not match the kind: that is a defect in the caller.
   */
  async enqueue<Kind extends EmailKind>(
    kind: Kind,
    props: ProducerProps<Kind>,
    recipient: EmailRecipient,
    dedupeKey: string,
  ): Promise<EnqueueOutcome> {
    const category = kind.category;
    const extras = isNotificationCategory(category) ? await this.notificationExtras(category, recipient) : NO_EXTRAS;
    if (extras === OPTED_OUT) {
      this.deps.log("email_enqueue_skipped", { kind: kind.name, dedupeKey, reason: "opted_out" });
      return "opted_out";
    }

    const id = await this.deps.deliveries.insert({
      kind: kind.name,
      props: kind.props.parse({ ...props, ...extras.props }),
      headers: extras.headers,
      recipientEmail: recipient.email.trim().toLowerCase(),
      recipientUserId: recipient.userId,
      dedupeKey,
    });
    if (!id) return "duplicate";

    await this.publish(id, kind.name);
    return "queued";
  }

  private async notificationExtras(
    category: EmailNotificationCategory,
    recipient: EmailRecipient,
  ): Promise<NotificationExtras | typeof OPTED_OUT> {
    const userId = recipient.userId;
    if (!userId) throw new Error(`A ${category} notification needs a recipient user.`);
    if ((await this.deps.preferences.disabledCategories(userId)).has(category)) return OPTED_OUT;

    const target = { userId, category };
    const [pageUrl, endpointUrl] = await Promise.all([
      this.deps.unsubscribe.urlFor(dashboardLinks.unsubscribePage(this.deps.links), target),
      this.deps.unsubscribe.urlFor(dashboardLinks.unsubscribeEndpoint(this.deps.links), target),
    ]);
    return { props: { unsubscribeUrl: pageUrl }, headers: unsubscribeHeaders(endpointUrl) };
  }

  /** A failed queue send is not fatal: the row stays `queued` and the sweeper sends it. */
  private async publish(deliveryId: string, kind: string): Promise<void> {
    if (!this.deps.queue) {
      this.deps.log("email_queue_send_failed", { deliveryId, kind, reason: "no_queue_binding" });
      return;
    }
    try {
      await this.deps.queue.send({ deliveryId });
      this.deps.log("email_enqueued", { deliveryId, kind });
    } catch (error) {
      this.deps.log("email_queue_send_failed", { deliveryId, kind, reason: errorName(error) });
    }
  }
}

interface NotificationExtras {
  readonly props: { readonly unsubscribeUrl?: string };
  readonly headers: Readonly<Record<string, string>>;
}

const NO_EXTRAS: NotificationExtras = { props: {}, headers: {} };
const OPTED_OUT = Symbol("opted_out");

/** Same secret as the invite tokens, with its own context prefix inside `UnsubscribeTokens`. */
export function unsubscribeTokensFromEnv(env: Pick<Env, "BETTER_AUTH_SECRET">): UnsubscribeTokens {
  return new UnsubscribeTokens(env.BETTER_AUTH_SECRET);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
