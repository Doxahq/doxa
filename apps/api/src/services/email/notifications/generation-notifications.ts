import { generationFinishedEmail } from "@doxahq/email/catalog";
import type { EmailAudience } from "../../../repositories/email-audience";
import { dashboardLinks, type EmailLinks } from "../email-links";
import type { NotificationOutbox } from "./notification-outbox";

export type GenerationOutcome = "succeeded" | "failed";

/** Tells the member who started a generation that it finished. Never throws. */
export interface GenerationNotifier {
  finished(jobId: string, outcome: GenerationOutcome, failureReason?: string): Promise<void>;
}

export interface GenerationEmailNotificationsDeps {
  readonly audience: Pick<EmailAudience, "generationAudience">;
  readonly notifications: NotificationOutbox;
  readonly links: EmailLinks;
}

const FAILURE_REASON_LIMIT = 300;

/**
 * One email for each job: the dedupe key is the job ID, so a repeated
 * completion call, or a late failure after a success, sends nothing more.
 * A cancelled job sends nothing: a person cancelled it.
 */
export class GenerationEmailNotifications implements GenerationNotifier {
  constructor(private readonly deps: GenerationEmailNotificationsDeps) {}

  finished(jobId: string, outcome: GenerationOutcome, failureReason?: string): Promise<void> {
    return this.deps.notifications.safely("generation-finished", jobId, async () => {
      const audience = await this.deps.audience.generationAudience(jobId);
      if (!audience?.requester) return;
      const reason = failureReason?.trim();
      await this.deps.notifications.notify(
        generationFinishedEmail,
        [audience.requester],
        () => ({
          projectName: audience.projectName,
          outcome,
          generationUrl: dashboardLinks.generation(this.deps.links, audience.projectId, jobId),
          ...(outcome === "failed" && reason ? { failureReason: reason.slice(0, FAILURE_REASON_LIMIT) } : {}),
        }),
        () => `generation-finished:${jobId}`,
      );
    });
  }
}
