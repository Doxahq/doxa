import { WorkerEntrypoint } from "cloudflare:workers";
import type { ClaimedEmailDelivery, EmailAttempt, EmailAttemptOutcome, EmailDeliveryRpc } from "@doxahq/email";
import type { Env } from "../../env";
import { EmailDeliveryService } from "./email-delivery-service";

/**
 * RPC entrypoint for the `doxa-email` Worker (service binding `API`,
 * entrypoint `EmailDeliveryApi`). Only that Worker binds to it.
 */
export class EmailDeliveryApi extends WorkerEntrypoint<Env> implements EmailDeliveryRpc {
  claimEmailDelivery(deliveryId: string): Promise<ClaimedEmailDelivery | null> {
    return EmailDeliveryService.fromEnv(this.env).claim(deliveryId);
  }

  recordEmailAttempt(attempt: EmailAttempt): Promise<EmailAttemptOutcome> {
    return EmailDeliveryService.fromEnv(this.env).record(attempt);
  }
}
