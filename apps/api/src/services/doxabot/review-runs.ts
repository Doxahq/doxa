import {
  createReviewRunInputSchema,
  updateReviewRunInputSchema,
  type CreateReviewRunInput,
  type DoxabotReviewRunState,
  type GenerationJobDto,
  type ReviewRunConclusion,
  type ReviewRunResult,
  type ReviewRunStatus,
  type SourceProvider,
  type UpdateReviewRunInput,
} from "@doxahq/contracts";
import type { Env } from "../../env";
import type { CancelledReviewRunPresentation } from "../../repositories/cancelled-review-run";
import {
  JobsRepository,
  type ReviewRunJobContext,
  type ReviewRunJobsStore,
} from "../../repositories/jobs";
import {
  GitHubChecksAdapter,
} from "./github-checks";

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

export interface ReviewRunsDependencies {
  jobs: ReviewRunJobsStore;
  adapters: Record<SourceProvider, ReviewRunProviderAdapter>;
  createClaimToken(): string;
  now(): Date;
}

export class ReviewRunsService implements ReviewRunReporter, ReviewRunCanceller {
  constructor(private readonly dependencies: ReviewRunsDependencies) {}

  static fromEnv(env: Env): ReviewRunsService {
    return new ReviewRunsService({
      jobs: new JobsRepository(env),
      adapters: {
        github: GitHubChecksAdapter.fromEnv(env),
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
    const input = withDisplaySummary(agreeWithJob(context, parsed));

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
        const updated = await adapter.update(context, {
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
      await this.adapterFor(context).update(context, {
        ...withDisplaySummary(agreeWithJob(context, written)),
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

    const updated = await this.adapterFor(context).update(context, input);
    return { ...updated, outcome: "updated" };
  }

  async cancel(
    jobId: string,
    presentation: CancelledReviewRunPresentation,
  ): Promise<boolean> {
    const context = await this.dependencies.jobs.getReviewRunContext(jobId);
    const externalRunId = context?.externalReviewRunId ?? null;
    // A check that is still being created gets the job's state from its
    // creator; there is no run ID to update yet.
    if (!context || externalRunId === null || isPendingReviewRunId(externalRunId)) {
      return false;
    }

    const input = withDisplaySummary(
      updateReviewRunInputSchema.parse({
        externalRunId,
        ...mapDoxabotReviewRunState("cancelled"),
        title: presentation.title,
        summary: presentation.summary,
        detailsUrl: null,
        sourceRevision: context.targetRevision,
      }),
    );
    await this.adapterFor(context).update(context, input);
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

    const updated = await this.adapterFor(context).update(context, {
      ...input,
      externalRunId,
    });
    return { ...updated, outcome: "updated" };
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
        title: "Documentation preview failed",
        summary:
          "Doxa could not generate a documentation preview for this pull request.",
      };
    case "cancelled":
      return {
        ...mapDoxabotReviewRunState("cancelled"),
        title: "Documentation preview cancelled",
        summary:
          "Doxa cancelled documentation preview generation for this pull request.",
      };
  }
}

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
  }
}

/**
 * The input as written, or the job's own state when the input contradicts it.
 * Only an ended job can disagree, and its state always names a conclusion.
 * A cancelled job reads as its cancel says, for example "stopped" for a
 * closed pull request, when the cancel stored a text.
 */
function agreeWithJob(
  context: Pick<ReviewRunJobContext, "status" | "cancelledPresentation">,
  input: CreateReviewRunInput,
): CreateReviewRunInput {
  if (checkAgreesWithJob(context.status, input)) return input;
  return {
    ...input,
    ...reviewRunPresentationFor(context.status),
    ...(context.status === "cancelled" ? context.cancelledPresentation : null),
  };
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
  }
}

export function withDisplaySummary<T extends CreateReviewRunInput>(
  input: T,
): T {
  const lines = [input.summary];
  if (input.detailsUrl) {
    lines.push(`Preview: ${input.detailsUrl}`);
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

function metric(label: string, value: number | undefined): string | null {
  return value === undefined ? null : `${label}: ${value}`;
}

function isPendingReviewRunId(value: string): boolean {
  return value.startsWith("pending:");
}
