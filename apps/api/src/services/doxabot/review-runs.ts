import {
  createReviewRunInputSchema,
  updateReviewRunInputSchema,
  type CreateReviewRunInput,
  type DoxabotReviewRunState,
  type ReviewRunConclusion,
  type ReviewRunResult,
  type ReviewRunStatus,
  type SourceProvider,
  type UpdateReviewRunInput,
} from "@doxahq/contracts";
import type { Env } from "../../env";
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

export class ReviewRunsService implements ReviewRunReporter {
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
    const input = withDisplaySummary(
      createReviewRunInputSchema.parse(rawInput),
    );
    const context = await this.requireContext(jobId, input.sourceRevision);

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
    return { ...created, outcome: "created" };
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

    const updated = await this.adapterFor(context).update(context, input);
    return { ...updated, outcome: "updated" };
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
