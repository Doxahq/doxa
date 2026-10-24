import type { Env } from "../../env";
import { EmailDeliveriesRepository } from "../../repositories/email-deliveries";
import type { EmailDeliveryStore, StaleLimits } from "./email-delivery-store";
import { consoleEmailLog, type EmailLog } from "./email-log";
import type { EmailQueueProducer } from "./email-outbox";

/** Cloudflare Queues accepts at most 100 messages in one `sendBatch`. */
const QUEUE_BATCH_LIMIT = 100;

export const EMAIL_SWEEP_LIMITS: StaleLimits = {
  queuedGraceMs: 2 * 60 * 1000,
  sendingTimeoutMs: 10 * 60 * 1000,
  batchSize: QUEUE_BATCH_LIMIT,
};

export interface EmailDeliverySweeperDeps {
  readonly deliveries: Pick<EmailDeliveryStore, "takeStale">;
  readonly queue: EmailQueueProducer;
  readonly now: () => Date;
  readonly log: EmailLog;
}

/**
 * Sends stuck deliveries to the queue again (email spec §9.4): a `queued` row
 * whose queue send failed, and a `sending` row whose Worker stopped. A
 * duplicate queue message is harmless, because only one claim can win.
 */
export class EmailDeliverySweeper {
  constructor(private readonly deps: EmailDeliverySweeperDeps) {}

  /** `null` when this Worker has no email queue binding. */
  static fromEnv(env: Env): EmailDeliverySweeper | null {
    if (!env.EMAIL_QUEUE) return null;
    return new EmailDeliverySweeper({
      deliveries: EmailDeliveriesRepository.fromEnv(env),
      queue: env.EMAIL_QUEUE,
      now: () => new Date(),
      log: consoleEmailLog,
    });
  }

  async run(): Promise<number> {
    const ids = await this.deps.deliveries.takeStale(this.deps.now(), EMAIL_SWEEP_LIMITS);
    if (ids.length > 0) await this.deps.queue.sendBatch(ids.map((deliveryId) => ({ body: { deliveryId } })));
    this.deps.log("email_sweep", { requeued: ids.length });
    return ids.length;
  }
}
