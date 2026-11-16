import {
  billingNotificationWindowKey,
  type BillingEnforcement,
  type BillingNotification,
  type BillingNotifier,
} from "@doxahq/billing";
import { roleHasCapability } from "@doxahq/contracts/teams";
import {
  creditsExhaustedEmail,
  creditsLowEmail,
  paygLimitEmail,
  paygStartedEmail,
} from "@doxahq/email/catalog";
import type { BillingAudience, EmailContact } from "../../../repositories/email-audience";
import { dashboardLinks, type EmailLinks } from "../email-links";
import type { NotificationOutbox } from "./notification-outbox";

/** The owner of a billing account, as the store holds it. */
export interface BillingAccountOwner {
  readonly ownerKind: "user" | "team";
  /** Null after the owner is deleted (billing spec 16.3): nobody gets the email. */
  readonly ownerId: string | null;
}

export type BillingNotificationLog = (event: string, fields: Readonly<Record<string, string | number | boolean | null>>) => void;

export interface BillingEmailNotificationsDeps {
  /** `off`: nothing. `shadow`: log what would be sent. `on`: send. */
  readonly mode: BillingEnforcement;
  readonly owner: (accountId: string) => Promise<BillingAccountOwner | null>;
  readonly audience: BillingAudience;
  readonly notifications: NotificationOutbox;
  readonly links: EmailLinks;
  /** Credit price in cents (catalog `credit.unitPriceCents`). */
  readonly unitPriceCents: number;
  readonly log: BillingNotificationLog;
}

/**
 * The billing emails of spec 10.7: `credits-low`, `payg-started`,
 * `payg-limit` and `credits-exhausted`. Recipients: the owner of a personal
 * account; for a team, the members with `billing.manage` (owner and admins).
 * Each delivery's dedupe key is the notice's window key plus the recipient,
 * so each notice goes out at most once a window. Never throws.
 */
export class BillingEmailNotifications implements BillingNotifier {
  constructor(private readonly deps: BillingEmailNotificationsDeps) {}

  async notify(notification: BillingNotification): Promise<void> {
    const { mode } = this.deps;
    if (mode === "off") return;
    const key = billingNotificationWindowKey(notification);
    if (mode === "shadow") {
      this.deps.log("billing.notification_shadow", { kind: notification.kind, accountId: notification.accountId, key });
      return;
    }
    await this.deps.notifications.safely(notification.kind, notification.accountId, async () => {
      const recipients = await this.recipients(notification.accountId);
      if (!recipients) return;
      const { contacts, teamName } = recipients;
      const base = {
        ...(teamName ? { teamName } : {}),
        billingUrl: dashboardLinks.billing(this.deps.links, notification.accountId),
      };
      const dedupe = (contact: EmailContact) => `billing:${key}:${contact.userId}`;
      const notify = this.deps.notifications;
      switch (notification.kind) {
        case "credits-low":
          await notify.notify(creditsLowEmail, contacts, () => ({
            ...base,
            usedCredits: notification.usedCredits,
            allowanceCredits: notification.allowanceCredits,
            resetsOn: formatDay(notification.windowEnd),
            paygOn: notification.paygOn,
          }), dedupe);
          return;
        case "payg-started":
          await notify.notify(paygStartedEmail, contacts, () => ({
            ...base,
            chargeAtUsd: this.creditsUsd(notification.chargeAtCredits),
            monthlyLimitUsd: formatCents(notification.monthlyLimitCents),
            resetsOn: formatDay(notification.windowEnd),
          }), dedupe);
          return;
        case "payg-limit":
          await notify.notify(paygLimitEmail, contacts, () => ({
            ...base,
            percent: notification.percent,
            spentUsd: this.creditsUsd(notification.debtCredits),
            monthlyLimitUsd: formatCents(notification.monthlyLimitCents),
            chargeAtUsd: this.creditsUsd(notification.chargeAtCredits),
            resetsOn: formatDay(notification.windowEnd),
          }), dedupe);
          return;
        case "credits-exhausted":
          await notify.notify(creditsExhaustedEmail, contacts, () => ({
            ...base,
            ...(notification.trialCredits ? { trialCredits: notification.trialCredits } : {}),
          }), dedupe);
          return;
      }
    });
  }

  private async recipients(accountId: string): Promise<{ contacts: readonly EmailContact[]; teamName: string | null } | null> {
    const owner = await this.deps.owner(accountId);
    if (!owner?.ownerId) return null;
    if (owner.ownerKind === "user") {
      const contact = (await this.deps.audience.contactsFor([owner.ownerId])).get(owner.ownerId);
      return contact ? { contacts: [contact], teamName: null } : null;
    }
    const team = await this.deps.audience.teamAudience(owner.ownerId);
    if (!team) return null;
    const managers = team.members.filter((member) => roleHasCapability(member.role, "billing.manage"));
    return { contacts: managers, teamName: team.teamName };
  }

  private creditsUsd(credits: number): string {
    return formatCents(credits * this.deps.unitPriceCents);
  }
}

/** `$30` for whole dollars, else `$12.40`. */
export function formatCents(cents: number): string {
  const safe = Math.max(0, Math.round(cents));
  return safe % 100 === 0 ? `$${safe / 100}` : `$${(safe / 100).toFixed(2)}`;
}

/** `December 1, 2026`, in UTC like the allowance windows. */
export function formatDay(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(date);
}
