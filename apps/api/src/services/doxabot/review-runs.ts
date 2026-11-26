import {
  createReviewRunInputSchema,
  updateReviewRunInputSchema,
  type CreateReviewRunInput,
  type DoxabotReviewRunState,
  type FailedJobCheck,
  type GenerationJobDto,
  type ReviewRunAction,
  type ReviewRunConclusion,
  type ReviewRunResult,
  type ReviewRunStatus,
  type SourceProvider,
  type TimedOutJobStatus,
  type UpdateReviewRunInput,
} from "@doxahq/contracts";
import type { Env } from "../../env";
import type { CancelledReviewRunPresentation } from "../../repositories/cancelled-review-run";
import {
  JobsRepository,
  type ReviewRunJobContext,
  type ReviewRunJobsStore,
} from "../../repositories/jobs";
import { dashboardLinks, emailLinksFromEnv } from "../email/email-links";
import {
  GitHubChecksAdapter,
} from "./github-checks";
import { RETRY_PREVIEW_ACTION_ID } from "./preview-check-identity";

export interface ReviewRunReporter {
  create(
    jobId: string,
    input: CreateReviewRunInput,
  ): Promise<ReviewRunResult>;
  update(
    jobId: string,
    input: UpdateReviewRunInput,
  ): Promise<ReviewRunResult>;
}

export interface ReviewRunCanceller {
  /**
   * Completes the check of a preview job as cancelled. False when the job has
   * no check to close: not a preview, or its check was never created.
   */
  cancel(
    jobId: string,
    presentation: CancelledReviewRunPresentation,
  ): Promise<boolean>;
}

export interface ReviewRunProviderAdapter {
  find(
    context: ReviewRunJobContext,
  ): Promise<{ externalRunId: string } | null>;
  create(
    context: ReviewRunJobContext,
    input: CreateReviewRunInput,
  ): Promise<{ externalRunId: string }>;
  update(
    context: ReviewRunJobContext,
    input: UpdateReviewRunInput,
  ): Promise<{ externalRunId: string }>;
}

/** Dashboard pages that a check links to. */
export interface ReviewRunLinks {
  generation(projectId: string, jobId: string): string;
}

export interface ReviewRunsDependencies {
  jobs: ReviewRunJobsStore;
  adapters: Record<SourceProvider, ReviewRunProviderAdapter>;
  links: ReviewRunLinks;
  createClaimToken(): string;
  now(): Date;
}

/** A conclusion that ends a check. */
export type ReviewRunEndState = Exclude<DoxabotReviewRunState, "queued" | "in_progress">;

/** How the check of an ended job reads. */
export interface ReviewRunEnding {
  title: string;
  summary: string;
  /**
   * The check's link. When it is absent, a failure and a retryable end link
   * to the run in the dashboard, and other ends have no link.
   */
  detailsUrl?: string | null;
  /** Shows the "Retry preview" button. GitHub shows it on a completed check only. */
  retryable?: boolean;
}

export const RETRY_PREVIEW_ACTION = {
  label: "Retry preview",
  description: "Run this documentation preview again",
  identifier: RETRY_PREVIEW_ACTION_ID,
} as const satisfies ReviewRunAction;

const FAILED_PREVIEW_TITLE = "Documentation preview failed";
const FAILED_PREVIEW_SUMMARY =
  "Doxa could not generate a documentation preview for this pull request.";

/** The check of a preview run that failed: the reason, a link to the run, and a retry. */
export function failedPreviewEnding(message: string | null): ReviewRunEnding {
  return {
    title: FAILED_PREVIEW_TITLE,
    summary: message?.trim() || FAILED_PREVIEW_SUMMARY,
    retryable: true,
  };
}

/**
 * The check of a failed run. The worker names the end when a retry cannot
 * help, for example a merge conflict (`action_required`, no button).
 */
export function failedJobEnd(
  message: string,
  check?: FailedJobCheck,
): { state: ReviewRunEndState; ending: ReviewRunEnding } {
  if (!check) return { state: "failure", ending: failedPreviewEnding(message) };
  return {
    state: check.conclusion,
    ending: {
      title: check.title,
      summary: check.summary,
      retryable: check.conclusion === "failure",
    },
  };
}

const TIMED_OUT_SUMMARY: Record<TimedOutJobStatus, string> = {
  queued: "Doxa did not start this preview in time.",
  running: "The preview ran longer than its time limit, so Doxa stopped it.",
};

/** The check of a run that the watchdog ended because it waited or ran too long. */
export function timedOutPreviewEnding(status: TimedOutJobStatus): ReviewRunEnding {
  return {
    title: "Documentation preview timed out",
    summary: `${TIMED_OUT_SUMMARY[status]} Retry it, or push a new commit to start a new preview.`,
    retryable: true,
  };
}

export class ReviewRunsService implements ReviewRunReporter, ReviewRunCanceller {
  constructor(private readonly dependencies: ReviewRunsDependencies) {}

  static fromEnv(env: Env): ReviewRunsService {
    const links = emailLinksFromEnv(env);
    return new ReviewRunsService({
      jobs: new JobsRepository(env),
      adapters: {
        github: GitHubChecksAdapter.fromEnv(env),
      },
      links: {
        generation: (projectId, jobId) => dashboardLinks.generation(links, projectId, jobId),
      },
      createClaimToken: () => crypto.randomUUID(),
      now: () => new Date(),
    });
  }

  async create(
    jobId: string,
    rawInput: CreateReviewRunInput,
  ): Promise<ReviewRunResult> {
    const parsed = createReviewRunInputSchema.parse(rawInput);
    const context = await this.requireContext(jobId, parsed.sourceRevision);
    // The caller read the job before this call; the check shows it as it is now.
    const input = withDisplaySummary(this.agreeWithJob(context, parsed));

    if (
      context.externalReviewRunId !== null &&
      !isPendingReviewRunId(context.externalReviewRunId)
    ) {
      return this.updateExisting(context, input);
    }

    const claimToken = this.dependencies.createClaimToken();
    const claimedAt = this.dependencies.now();
    const claim = await this.dependencies.jobs.claimReviewRun({
      jobId,
      claimToken,
      claimedAt,
    });

    switch (claim.outcome) {
      case "existing":
        return this.updateExisting(context, input, claim.externalRunId);
      case "pending":
        throw new Error("Review run creation is already in progress.");
      case "not_found":
        throw new Error("Doxabot review-run job was not found.");
      case "claimed":
        break;
    }

    const adapter = this.adapterFor(context);
    if (claim.reconcile) {
      const reconciled = await adapter.find(context);
      if (reconciled) {
        await this.completeClaim({
          jobId,
          claimToken,
          claimedAt,
          externalRunId: reconciled.externalRunId,
        });
        const updated = await this.write(context, {
          ...input,
          externalRunId: reconciled.externalRunId,
        });
        await this.settleWithJob(jobId, reconciled.externalRunId, input);
        return { ...updated, outcome: "updated" };
      }
    }

    const created = await adapter.create(context, input);
    await this.completeClaim({
      jobId,
      claimToken,
      claimedAt,
      externalRunId: created.externalRunId,
    });
    await this.recordCompletion(context, created.externalRunId, input);
    await this.settleWithJob(jobId, created.externalRunId, input);
    return { ...created, outcome: "created" };
  }

  /**
   * A cancel that runs while the check is being created finds no run ID and
   * leaves the check alone (`cancel`). Once the ID is stored, the creator
   * reads the job again and closes the check if the job ended meanwhile,
   * with the text that the cancel stored.
   */
  private async settleWithJob(
    jobId: string,
    externalRunId: string,
    written: CreateReviewRunInput,
  ): Promise<void> {
    try {
      const context = await this.dependencies.jobs.getReviewRunContext(jobId);
      if (!context || checkAgreesWithJob(context.status, written)) return;
      await this.write(context, {
        ...withDisplaySummary(this.agreeWithJob(context, written)),
        externalRunId,
      });
    } catch {
      // The check exists and its ID is stored, so the creation succeeded. A
      // failed correction must not report it as failed: the caller would then
      // drop the stored ID for this delivery.
    }
  }

  private async completeClaim(input: {
    jobId: string;
    claimToken: string;
    claimedAt: Date;
    externalRunId: string;
  }): Promise<void> {
    const persisted =
      await this.dependencies.jobs.completeReviewRunClaim(input);
    if (!persisted) {
      throw new Error("Review run ID could not be persisted.");
    }
  }

  async update(
    jobId: string,
    rawInput: UpdateReviewRunInput,
  ): Promise<ReviewRunResult> {
    const input = withDisplaySummary(
      updateReviewRunInputSchema.parse(rawInput),
    );
    const context = await this.requireContext(jobId, input.sourceRevision);
    if (context.externalReviewRunId === null) {
      throw new Error("Doxabot review run has not been created.");
    }
    if (isPendingReviewRunId(context.externalReviewRunId)) {
      throw new Error("Review run creation is already in progress.");
    }
    if (context.externalReviewRunId !== input.externalRunId) {
      throw new Error("Review run ID does not belong to this generation job.");
    }
    // A worker step that started before a cancel must not reopen the check.
    if (!checkAgreesWithJob(context.status, input)) {
      return { externalRunId: input.externalRunId, outcome: "skipped" };
    }

    const updated = await this.write(context, input);
    return { ...updated, outcome: "updated" };
  }

  async cancel(
    jobId: string,
    presentation: CancelledReviewRunPresentation,
  ): Promise<boolean> {
    return this.finish(jobId, "cancelled", presentation);
  }

  /**
   * Completes the check of an ended job with `state`, for an end that the
   * worker does not report itself: a failure, a cancel, or a run that AI
   * credits stopped (`neutral`, billing spec 10.6). False when the check has
   * no run ID yet; its creator then reads the job's state.
   */
  async finish(
    jobId: string,
    state: ReviewRunEndState,
    ending: ReviewRunEnding,
  ): Promise<boolean> {
    const context = await this.dependencies.jobs.getReviewRunContext(jobId);
    if (!context) return false;
    return this.close(context, state, ending);
  }

  /**
   * Completes the open check of a job that ended without closing it, with
   * the job's own end. False when the job is still active or has no check.
   */
  async closeForEndedJob(jobId: string): Promise<boolean> {
    const context = await this.dependencies.jobs.getReviewRunContext(jobId);
    const end = context ? endingOfJob(context) : null;
    if (!context || !end) return false;
    return this.close(context, end.state, end.ending);
  }

  private async close(
    context: ReviewRunJobContext,
    state: ReviewRunEndState,
    ending: ReviewRunEnding,
  ): Promise<boolean> {
    const externalRunId = context.externalReviewRunId;
    // A check that is still being created gets the job's state from its
    // creator; there is no run ID to update yet.
    if (externalRunId === null || isPendingReviewRunId(externalRunId)) {
      return false;
    }

    const input = withDisplaySummary(
      updateReviewRunInputSchema.parse({
        externalRunId,
        ...this.endingFields(context, state, ending),
        sourceRevision: context.targetRevision,
      }),
    );
    await this.write(context, input);
    return true;
  }

  private async updateExisting(
    context: ReviewRunJobContext,
    input: CreateReviewRunInput,
    externalRunId = context.externalReviewRunId,
  ): Promise<ReviewRunResult> {
    if (externalRunId === null) {
      throw new Error("Doxabot review run has not been created.");
    }
    if (isPendingReviewRunId(externalRunId)) {
      throw new Error("Review run creation is already in progress.");
    }

    const updated = await this.write(context, {
      ...input,
      externalRunId,
    });
    return { ...updated, outcome: "updated" };
  }

  /** Every update of an existing check goes through here, so a completed check is recorded. */
  private async write(
    context: ReviewRunJobContext,
    input: UpdateReviewRunInput,
  ): Promise<{ externalRunId: string }> {
    const written = await this.adapterFor(context).update(context, input);
    await this.recordCompletion(context, written.externalRunId, input);
    return written;
  }

  /**
   * Records the closed check of an ended job. The check of an active job
   * can open again (a queue failure completes it, then the run starts), so
   * only the job's end counts. The check is closed on the provider either
   * way: a failed record only means that the cron closes it once more, so
   * it never fails the caller.
   */
  private async recordCompletion(
    context: Pick<ReviewRunJobContext, "jobId" | "status">,
    externalRunId: string,
    input: { status: ReviewRunStatus },
  ): Promise<void> {
    if (input.status !== "completed" || isActiveJob(context.status)) return;
    try {
      await this.dependencies.jobs.markReviewRunCompleted({
        jobId: context.jobId,
        externalRunId,
        completedAt: this.dependencies.now(),
      });
    } catch (error) {
      console.error("Review run completion could not be recorded.", {
        jobId: context.jobId,
        message: error instanceof Error ? error.message : "Unknown error.",
      });
    }
  }

  /**
   * The input as written, or the job's own end when the input contradicts
   * it. Only an ended job can disagree, and its state always names an end.
   */
  private agreeWithJob(
    context: ReviewRunJobContext,
    input: CreateReviewRunInput,
  ): CreateReviewRunInput {
    const end = endingOfJob(context);
    if (!end || checkAgreesWithJob(context.status, input)) return input;
    return { ...input, ...this.endingFields(context, end.state, end.ending) };
  }

  private endingFields(
    context: Pick<ReviewRunJobContext, "jobId" | "projectId">,
    state: ReviewRunEndState,
    ending: ReviewRunEnding,
  ): Pick<
    CreateReviewRunInput,
    "status" | "conclusion" | "title" | "summary" | "detailsUrl" | "actions"
  > {
    const linksToRun =
      ending.retryable === true || state === "failure" || state === "action_required";
    const detailsUrl =
      ending.detailsUrl !== undefined
        ? ending.detailsUrl
        : linksToRun
          ? this.dependencies.links.generation(context.projectId, context.jobId)
          : null;
    return {
      ...mapDoxabotReviewRunState(state),
      title: ending.title,
      summary: ending.summary,
      detailsUrl,
      ...(ending.retryable ? { actions: [RETRY_PREVIEW_ACTION] } : {}),
    };
  }

  private async requireContext(
    jobId: string,
    sourceRevision: string,
  ): Promise<ReviewRunJobContext> {
    const context =
      await this.dependencies.jobs.getReviewRunContext(jobId);
    if (!context) {
      throw new Error("Doxabot review-run job was not found.");
    }
    if (context.targetRevision !== sourceRevision) {
      throw new Error(
        "Review run source revision does not match the generation job.",
      );
    }
    return context;
  }

  private adapterFor(
    context: ReviewRunJobContext,
  ): ReviewRunProviderAdapter {
    return this.dependencies.adapters[context.provider];
  }
}

/**
 * The check of an ended job as its own end tells it: a failure with its
 * reason, or a cancel with the text that the cancel stored. Null while the
 * job is active.
 */
export function endingOfJob(
  context: Pick<ReviewRunJobContext, "status" | "errorMessage" | "cancelledPresentation">,
): { state: ReviewRunEndState; ending: ReviewRunEnding } | null {
  switch (context.status) {
    case "queued":
    case "running":
      return null;
    case "failed":
      return { state: "failure", ending: failedPreviewEnding(context.errorMessage) };
    case "cancelled":
      return {
        state: "cancelled",
        ending: context.cancelledPresentation ?? presentationText("cancelled"),
      };
    case "succeeded":
      return { state: "success", ending: presentationText("succeeded") };
    case "stopped_credits":
      return { state: "neutral", ending: { ...STOPPED_CREDITS_CHECK } };
  }
}

function presentationText(
  status: GenerationJobDto["status"],
): ReviewRunEnding {
  const { title, summary } = reviewRunPresentationFor(status);
  return { title, summary };
}

/** How the pull request check reads for a preview run in this state. */
export function reviewRunPresentationFor(
  status: GenerationJobDto["status"],
): Pick<
  CreateReviewRunInput,
  "status" | "conclusion" | "title" | "summary"
> {
  switch (status) {
    case "queued":
      return {
        ...mapDoxabotReviewRunState("queued"),
        title: "Documentation preview queued",
        summary:
          "Doxa is preparing a documentation preview for this pull request.",
      };
    case "running":
      return {
        ...mapDoxabotReviewRunState("in_progress"),
        title: "Documentation preview in progress",
        summary:
          "Doxa is generating a documentation preview for this pull request.",
      };
    case "succeeded":
      return {
        ...mapDoxabotReviewRunState("success"),
        title: "Documentation preview ready",
        summary:
          "Doxa generated a documentation preview for this pull request.",
      };
    case "failed":
      return {
        ...mapDoxabotReviewRunState("failure"),
        title: FAILED_PREVIEW_TITLE,
        summary: FAILED_PREVIEW_SUMMARY,
      };
    case "cancelled":
      return {
        ...mapDoxabotReviewRunState("cancelled"),
        title: "Documentation preview cancelled",
        summary:
          "Doxa cancelled documentation preview generation for this pull request.",
      };
    case "stopped_credits":
      return {
        ...mapDoxabotReviewRunState("neutral"),
        ...STOPPED_CREDITS_CHECK,
      };
  }
}

/** Billing spec 10.6: a run without credits finishes `neutral` and never fails the customer's CI. */
export const STOPPED_CREDITS_CHECK = {
  title: "AI credits ran out",
  summary:
    "Doxa stopped the documentation preview because the account's AI credits ran out. Add credits or raise the limit on the billing page, then run the preview again.",
} as const;

/**
 * Whether a check state fits the job. An active job takes any state: the
 * worker writes progress, and a queue failure completes the check while the
 * job waits. An ended job takes only the conclusion of its own end.
 */
export function checkAgreesWithJob(
  status: GenerationJobDto["status"],
  check: { status: ReviewRunStatus; conclusion?: ReviewRunConclusion },
): boolean {
  switch (status) {
    case "queued":
    case "running":
      return true;
    case "succeeded":
      return check.conclusion === "success";
    case "failed":
      return check.conclusion === "failure" || check.conclusion === "action_required";
    case "cancelled":
      return check.conclusion === "cancelled";
    case "stopped_credits":
      return check.conclusion === "neutral";
  }
}

export function mapDoxabotReviewRunState(state: DoxabotReviewRunState): {
  status: ReviewRunStatus;
  conclusion?: ReviewRunConclusion;
} {
  switch (state) {
    case "queued":
      return { status: "queued" };
    case "in_progress":
      return { status: "in_progress" };
    case "success":
      return { status: "completed", conclusion: "success" };
    case "failure":
      return { status: "completed", conclusion: "failure" };
    case "cancelled":
      return { status: "completed", conclusion: "cancelled" };
    case "action_required":
      return { status: "completed", conclusion: "action_required" };
    case "neutral":
      return { status: "completed", conclusion: "neutral" };
  }
}

export function withDisplaySummary<T extends CreateReviewRunInput>(
  input: T,
): T {
  const lines = [input.summary];
  if (input.detailsUrl) {
    lines.push(`${detailsLinkLabel(input.conclusion)}: ${input.detailsUrl}`);
  }

  const metrics = input.metrics;
  if (metrics) {
    const values = [
      metric("Changed sources", metrics.changedSourceCount),
      metric("Regenerated pages", metrics.regeneratedPageCount),
      metric("Reused pages", metrics.reusedPageCount),
    ].filter((value) => value !== null);
    if (values.length > 0) lines.push(values.join(" · "));
  }

  return {
    ...input,
    summary: lines.join("\n\n"),
  };
}

/**
 * What the check's link opens: the preview while the run goes or after it
 * worked, the billing page for a billing stop (spec 10.6), and the run in
 * the dashboard for every other end.
 */
function detailsLinkLabel(conclusion: ReviewRunConclusion | undefined): string {
  switch (conclusion) {
    case undefined:
    case "success":
      return "Preview";
    case "neutral":
      return "Billing";
    case "failure":
    case "cancelled":
    case "action_required":
      return "Details";
  }
}

function metric(label: string, value: number | undefined): string | null {
  return value === undefined ? null : `${label}: ${value}`;
}

function isActiveJob(status: GenerationJobDto["status"]): boolean {
  return status === "queued" || status === "running";
}

function isPendingReviewRunId(value: string): boolean {
  return value.startsWith("pending:");
}
