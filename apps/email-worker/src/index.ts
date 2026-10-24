import type { EmailDeliveryRpc, EmailEnv, EmailQueueMessage } from "@doxahq/email";
import { Mailer, findEmailTemplate } from "@doxahq/email/mailer";
import { processDelivery, type ProcessDeliveryDeps } from "./process-delivery";

export interface Env extends Omit<EmailEnv, "EMAIL"> {
  /** `EmailDeliveryApi` entrypoint of `doxa-api`. */
  API: EmailDeliveryRpc;
  EMAIL: SendEmail;
}

const SERVICE = "doxa-email";

export default {
  async queue(batch: MessageBatch<EmailQueueMessage>, env: Env): Promise<void> {
    const deps = createDeps(env);
    for (const message of batch.messages) {
      try {
        const outcome = await processDelivery(message.body.deliveryId, deps);
        if (outcome.action === "retry") message.retry({ delaySeconds: outcome.delaySeconds });
        else message.ack();
      } catch (error) {
        log("email_delivery_error", {
          deliveryId: message.body.deliveryId,
          error: error instanceof Error ? error.name : "unknown",
        });
        message.retry();
      }
    }
  },

  async fetch(): Promise<Response> {
    return Response.json({ ok: true, service: SERVICE });
  },
} satisfies ExportedHandler<Env, EmailQueueMessage>;

/** Built once for each batch. A configuration error throws, so every message of the batch retries. */
function createDeps(env: Env): ProcessDeliveryDeps {
  return {
    api: env.API,
    mailer: Mailer.fromEnv(env),
    findTemplate: findEmailTemplate,
    log,
  };
}

function log(event: string, data: Readonly<Record<string, string | number | null>>): void {
  console.log(JSON.stringify({ service: SERVICE, event, ...data }));
}
