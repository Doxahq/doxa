import type { Env } from "../../../env";
import { ApprovalSettingsRepository } from "../../../repositories/approval-settings";
import { EmailAudienceRepository } from "../../../repositories/email-audience";
import type { ApprovalNotifier } from "../../agent-actions/approval-notifier";
import type { ActionRegistry } from "../../agent-actions/registry";
import { consoleEmailLog } from "../email-log";
import { EmailOutbox } from "../email-outbox";
import { ApprovalEmailNotifications } from "./approval-notifications";
import { DomainEmailNotifications, type DomainNotifier } from "./domain-notifications";
import { GenerationEmailNotifications, type GenerationNotifier } from "./generation-notifications";
import { NotificationOutbox } from "./notification-outbox";
import { BillingEmailNotifications, type BillingAccountOwner } from "./billing-notifications";
import { DOXA_CATALOG, type BillingEnforcement, type BillingNotifier } from "@doxahq/billing";

export type { DomainNotifier, DomainStatusChange } from "./domain-notifications";
export type { GenerationNotifier, GenerationOutcome } from "./generation-notifications";
export type { BillingAccountOwner } from "./billing-notifications";

/*
 * The composition root of the notifiers: the only place they meet the env.
 * Each notifier is built on its first notification, so a request that sends
 * no email opens no extra database pool. A build error is logged, never thrown.
 */

function notificationParts(env: Env) {
  const outbox = EmailOutbox.fromEnv(env);
  return {
    audience: EmailAudienceRepository.fromEnv(env),
    notifications: new NotificationOutbox(outbox, consoleEmailLog),
    links: outbox.links,
  };
}

export function approvalNotifierFromEnv(
  env: Env,
  registry: ActionRegistry,
  defer: (work: Promise<unknown>) => void,
): ApprovalNotifier {
  const notifier = lazily("approval", () =>
    new ApprovalEmailNotifications({
      ...notificationParts(env),
      registry,
      flags: new ApprovalSettingsRepository(env),
      defer,
    }),
  );
  return {
    requested: (request) => notifier()?.requested(request),
    decided: (request, decision) => notifier()?.decided(request, decision),
  };
}

export function generationNotifierFromEnv(env: Env): GenerationNotifier {
  const notifier = lazily("generation", () => new GenerationEmailNotifications(notificationParts(env)));
  return { finished: async (...args) => notifier()?.finished(...args) };
}

export function domainNotifierFromEnv(env: Env): DomainNotifier {
  const notifier = lazily("domain", () => new DomainEmailNotifications(notificationParts(env)));
  return { statusChanged: async (change) => notifier()?.statusChanged(change) };
}

/**
 * The billing emails (billing spec 10.7). `mode` is `BILLING_ENFORCEMENT`:
 * `off` sends nothing and builds nothing, `shadow` logs, `on` sends.
 */
export function billingNotifierFromEnv(
  env: Env,
  mode: BillingEnforcement,
  owner: (accountId: string) => Promise<BillingAccountOwner | null>,
): BillingNotifier {
  if (mode === "off") return { notify: async () => undefined };
  const notifier = lazily("billing", () => {
    const parts = notificationParts(env);
    return new BillingEmailNotifications({
      mode,
      owner,
      audience: parts.audience,
      notifications: parts.notifications,
      links: parts.links,
      unitPriceCents: DOXA_CATALOG.credit.unitPriceCents,
      log: (event, fields) => console.log(JSON.stringify({ service: "doxa-api", event, mode, ...fields })),
    });
  });
  return { notify: async (notification) => notifier()?.notify(notification) };
}

/** Builds once on first use. Returns `undefined` (and logs) when the build fails. */
function lazily<T>(name: string, build: () => T): () => T | undefined {
  let built: T | undefined;
  return () => {
    if (built !== undefined) return built;
    try {
      built = build();
      return built;
    } catch (error) {
      consoleEmailLog("email_notification_failed", {
        notification: name,
        subjectId: null,
        error: error instanceof Error ? error.name : "unknown",
      });
      return undefined;
    }
  };
}
