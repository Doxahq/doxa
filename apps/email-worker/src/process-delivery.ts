import { emailFailed, type EmailDeliveryRpc, type SendEmailResult } from "@doxahq/email";
import type { EmailTemplate, Mailer } from "@doxahq/email/mailer";

export interface ProcessDeliveryDeps {
  readonly api: EmailDeliveryRpc;
  readonly mailer: Pick<Mailer, "provider" | "sendStored">;
  readonly findTemplate: (kind: string) => EmailTemplate | undefined;
  readonly log: (event: string, data: Readonly<Record<string, string | number | null>>) => void;
}

export type ProcessDeliveryOutcome =
  | { readonly action: "ack" }
  | { readonly action: "retry"; readonly delaySeconds: number };

/**
 * One queue message: claim the row, render and send its email, record the
 * result (email spec §9.3). RPC errors propagate, so the queue retries the message.
 */
export async function processDelivery(deliveryId: string, deps: ProcessDeliveryDeps): Promise<ProcessDeliveryOutcome> {
  const claim = await deps.api.claimEmailDelivery(deliveryId);
  if (!claim) {
    deps.log("email_claim_skipped", { deliveryId });
    return { action: "ack" };
  }

  const result = await sendClaimed(claim.kind, claim.props, claim, deps);
  const outcome = await deps.api.recordEmailAttempt({
    deliveryId: claim.id,
    claimToken: claim.claimToken,
    attempt: claim.attempt,
    result,
  });
  deps.log("email_attempt", {
    deliveryId,
    kind: claim.kind,
    attempt: claim.attempt,
    outcome: result.ok ? "sent" : result.kind,
    retryAfterSeconds: outcome.retryAfterSeconds,
  });
  return outcome.retryAfterSeconds === null
    ? { action: "ack" }
    : { action: "retry", delaySeconds: outcome.retryAfterSeconds };
}

async function sendClaimed(
  kind: string,
  props: unknown,
  claim: { readonly id: string; readonly recipientEmail: string; readonly headers: Readonly<Record<string, string>> },
  deps: ProcessDeliveryDeps,
): Promise<SendEmailResult> {
  const template = deps.findTemplate(kind);
  if (!template) return emailFailed(deps.mailer.provider, "invalid_message", `No template for the kind "${kind}".`);
  try {
    return await deps.mailer.sendStored(template, props, {
      to: { address: claim.recipientEmail },
      idempotencyKey: claim.id,
      headers: claim.headers,
    });
  } catch (error) {
    // The transport never throws, so this is a render defect, for example an unsafe link.
    const message = error instanceof Error ? error.message : "The template could not be rendered.";
    return emailFailed(deps.mailer.provider, "invalid_message", message);
  }
}
