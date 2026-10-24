import { roleHasCapability } from "@doxahq/contracts/teams";
import { domainStatusChangedEmail } from "@doxahq/email/catalog";
import type { EmailAudience } from "../../../repositories/email-audience";
import { dashboardLinks, type EmailLinks } from "../email-links";
import type { NotificationOutbox } from "./notification-outbox";

export interface DomainStatusChange {
  readonly projectId: string;
  readonly domainId: string;
  readonly hostname: string;
  readonly status: "active" | "failed";
  readonly failureReason: string | null;
  /** When the change was observed. Part of the dedupe key: each real change sends once. */
  readonly changedAt: Date;
}

/** Tells the members who manage domains that a custom domain went live or failed. Never throws. */
export interface DomainNotifier {
  statusChanged(change: DomainStatusChange): Promise<void>;
}

export interface DomainEmailNotificationsDeps {
  readonly audience: Pick<EmailAudience, "projectAudience">;
  readonly notifications: NotificationOutbox;
  readonly links: EmailLinks;
}

export class DomainEmailNotifications implements DomainNotifier {
  constructor(private readonly deps: DomainEmailNotificationsDeps) {}

  statusChanged(change: DomainStatusChange): Promise<void> {
    return this.deps.notifications.safely("domain-status-changed", change.domainId, async () => {
      const audience = await this.deps.audience.projectAudience(change.projectId);
      if (!audience) return;
      const managers = audience.members.filter((member) => roleHasCapability(member.role, "domains.write"));
      const reason = change.failureReason?.trim();
      await this.deps.notifications.notify(
        domainStatusChangedEmail,
        managers,
        () => ({
          projectName: audience.projectName,
          hostname: change.hostname,
          status: change.status,
          domainsUrl: dashboardLinks.domains(this.deps.links, change.projectId),
          ...(change.status === "failed" && reason ? { failureReason: reason.slice(0, 300) } : {}),
        }),
        (contact) =>
          `domain-status-changed:${change.domainId}:${change.status}:${change.changedAt.toISOString()}:${contact.userId}`,
      );
    });
  }
}
