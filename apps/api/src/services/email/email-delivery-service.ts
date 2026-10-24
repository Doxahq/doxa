import {
  decideDelivery,
  type ClaimedEmailDelivery,
  type DeliveryDecision,
  type EmailAttempt,
  type EmailAttemptOutcome,
  type SendEmailResult,
} from "@doxahq/email";
import type { Env } from "../../env";
import { EmailDeliveriesRepository, EmailSuppressionsRepository } from "../../repositories/email-deliveries";
import type { DeliveryUpdate, EmailDeliveryStore, EmailSuppressionStore } from "./email-delivery-store";
import { consoleEmailLog, type EmailLog } from "./email-log";

export interface EmailDeliveryServiceDeps {
  readonly deliveries: Pick<EmailDeliveryStore, "claim" | "complete">;
  readonly suppressions: EmailSuppressionStore;
  readonly now: () => Date;
  readonly log: EmailLog;
}

/** Marks rows that Doxa itself refused, so the log tells them apart from provider results. */
const DOXA_PROVIDER = "doxa";

/**
 * The API side of one delivery attempt (email spec §9.3). The `doxa-email`
 * Worker claims a row, sends it, and records the result here.
 */
export class EmailDeliveryService {
  constructor(private readonly deps: EmailDeliveryServiceDeps) {}

  static fromEnv(env: Env): EmailDeliveryService {
    return new EmailDeliveryService({
      deliveries: EmailDeliveriesRepository.fromEnv(env),
      suppressions: EmailSuppressionsRepository.fromEnv(env),
      now: () => new Date(),
      log: consoleEmailLog,
    });
  }

  async claim(deliveryId: string): Promise<ClaimedEmailDelivery | null> {
    const claim = await this.deps.deliveries.claim(deliveryId, this.deps.now());
    if (!claim) return null;
    if (!(await this.deps.suppressions.isSuppressed(claim.recipientEmail))) return claim;

    await this.deps.deliveries.complete(
      claim.id,
      claim.claimToken,
      {
        status: "suppressed",
        provider: DOXA_PROVIDER,
        failure: { kind: "recipient_suppressed", message: "The address is on the Doxa suppression list." },
      },
      this.deps.now(),
    );
    this.deps.log("email_attempt_recorded", { deliveryId, status: "suppressed", provider: DOXA_PROVIDER });
    return null;
  }

  async record(attempt: EmailAttempt): Promise<EmailAttemptOutcome> {
    const now = this.deps.now();
    const decision = decideDelivery(attempt.result, attempt.attempt);
    const update = toUpdate(attempt.result, decision, now);

    const recipient = await this.deps.deliveries.complete(attempt.deliveryId, attempt.claimToken, update, now);
    if (!recipient) {
      this.deps.log("email_claim_lost", { deliveryId: attempt.deliveryId });
      return { retryAfterSeconds: null };
    }
    if (update.status === "suppressed") {
      await this.deps.suppressions.suppress([{ email: recipient, reason: "provider", source: update.provider }]);
    }
    this.deps.log("email_attempt_recorded", {
      deliveryId: attempt.deliveryId,
      attempt: attempt.attempt,
      status: update.status,
      provider: update.provider,
      failureKind: attempt.result.ok ? null : attempt.result.kind,
      providerCode: attempt.result.ok ? null : (attempt.result.providerCode ?? null),
    });
    return { retryAfterSeconds: decision.action === "retry" ? decision.delaySeconds : null };
  }
}

function toUpdate(result: SendEmailResult, decision: DeliveryDecision, now: Date): DeliveryUpdate {
  if (result.ok) return { status: "sent", provider: result.provider, providerMessageId: result.messageId };
  const failure = {
    kind: result.kind,
    message: result.message,
    ...(result.providerCode ? { providerCode: result.providerCode } : {}),
  };
  if (decision.action === "retry") {
    return { status: "queued", provider: result.provider, failure, retryAt: new Date(now.getTime() + decision.delaySeconds * 1000) };
  }
  return { status: decision.status === "suppressed" ? "suppressed" : "failed", provider: result.provider, failure };
}
