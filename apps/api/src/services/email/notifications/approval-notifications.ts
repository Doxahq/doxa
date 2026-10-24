import { roleHasCapability } from "@doxahq/contracts/teams";
import { approvalDecidedEmail, approvalRequestedEmail } from "@doxahq/email/catalog";
import type { ApprovalRequestRecord } from "../../../repositories/agent-approval-requests";
import type { ApprovalSettingsStore } from "../../../repositories/approval-settings";
import type { EmailAudience, EmailContact } from "../../../repositories/email-audience";
import type { ApprovalDecision, ApprovalNotifier } from "../../agent-actions/approval-notifier";
import type { ActionRegistry } from "../../agent-actions/registry";
import { dashboardLinks, type EmailLinks } from "../email-links";
import type { NotificationOutbox } from "./notification-outbox";

/** `project.create` has no project yet: its request belongs to the requester's account. */
const ACCOUNT_LABEL = "your Doxa account";
/** A project that is gone, for example after an approved delete. */
const MISSING_PROJECT_LABEL = "a Doxa project";

export interface ApprovalEmailNotificationsDeps {
  readonly registry: ActionRegistry;
  readonly audience: EmailAudience;
  readonly flags: Pick<ApprovalSettingsStore, "projectFlags">;
  readonly notifications: NotificationOutbox;
  readonly links: EmailLinks;
  /** Keeps the work alive after the response (`waitUntil`). */
  readonly defer: (work: Promise<unknown>) => void;
}

/**
 * `approval-requested` goes to every member who could approve: the role has
 * `approvals.decide` and the action's capability, and the requester is left
 * out when the project requires another decider. `approval-decided` goes to
 * the member whose agent asked, unless they decided themselves.
 */
export class ApprovalEmailNotifications implements ApprovalNotifier {
  constructor(private readonly deps: ApprovalEmailNotificationsDeps) {}

  requested(request: ApprovalRequestRecord): void {
    this.deps.defer(
      this.deps.notifications.safely("approval-requested", request.id, () => this.sendRequested(request)),
    );
  }

  decided(request: ApprovalRequestRecord, decision: ApprovalDecision): void {
    if (request.decidedByUserId === null || request.decidedByUserId === request.requestedByUserId) return;
    this.deps.defer(
      this.deps.notifications.safely("approval-decided", request.id, () => this.sendDecided(request, decision)),
    );
  }

  private async sendRequested(request: ApprovalRequestRecord): Promise<void> {
    const action = this.deps.registry.find(request.actionKind);
    if (!action) return;
    const { projectName, deciders } = await this.decidersOf(request, action.capability);
    const contacts = await this.deps.audience.contactsFor([request.requestedByUserId]);
    const requesterName = contacts.get(request.requestedByUserId)?.name ?? "A team member";

    await this.deps.notifications.notify(
      approvalRequestedEmail,
      deciders,
      () => ({
        projectName,
        actionSummary: this.summaryOf(request),
        requesterName,
        agentName: request.requestedByClientName,
        reviewUrl: dashboardLinks.approvalRequest(this.deps.links, request.id),
      }),
      (contact) => `approval-requested:${request.id}:${contact.userId}`,
    );
  }

  private async sendDecided(request: ApprovalRequestRecord, decision: ApprovalDecision): Promise<void> {
    const deciderId = request.decidedByUserId;
    if (deciderId === null) return;
    const [contacts, audience] = await Promise.all([
      this.deps.audience.contactsFor([request.requestedByUserId, deciderId]),
      request.projectId ? this.deps.audience.projectAudience(request.projectId) : Promise.resolve(null),
    ]);
    const requester = contacts.get(request.requestedByUserId);
    if (!requester) return;

    await this.deps.notifications.notify(
      approvalDecidedEmail,
      [requester],
      () => ({
        projectName: request.projectId ? (audience?.projectName ?? MISSING_PROJECT_LABEL) : ACCOUNT_LABEL,
        actionSummary: this.summaryOf(request),
        decision,
        deciderName: contacts.get(deciderId)?.name ?? "A team member",
        requestUrl: dashboardLinks.approvalRequest(this.deps.links, request.id),
      }),
      () => `approval-decided:${request.id}`,
    );
  }

  private async decidersOf(
    request: ApprovalRequestRecord,
    capability: Parameters<typeof roleHasCapability>[1],
  ): Promise<{ projectName: string; deciders: EmailContact[] }> {
    if (request.projectId === null) {
      const requester = (await this.deps.audience.contactsFor([request.requestedByUserId])).get(request.requestedByUserId);
      return { projectName: ACCOUNT_LABEL, deciders: requester ? [requester] : [] };
    }
    const [audience, flags] = await Promise.all([
      this.deps.audience.projectAudience(request.projectId),
      this.deps.flags.projectFlags(request.projectId),
    ]);
    if (!audience) return { projectName: MISSING_PROJECT_LABEL, deciders: [] };
    const excludeRequester = flags?.requireOtherDecider ?? false;
    const deciders = audience.members.filter(
      (member) =>
        roleHasCapability(member.role, "approvals.decide") &&
        roleHasCapability(member.role, capability) &&
        !(excludeRequester && member.userId === request.requestedByUserId),
    );
    return { projectName: audience.projectName, deciders };
  }

  /** The action's own headline, or its title when the stored payload no longer parses. */
  private summaryOf(request: ApprovalRequestRecord): string {
    const action = this.deps.registry.find(request.actionKind);
    const headline = action?.restore(request)?.description.headline;
    return truncate(headline ?? action?.title ?? request.actionKind, 200);
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
