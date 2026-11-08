import type {
  GenerationActionBlockedReason,
  GenerationExecutionConfig,
  GenerationJobDto,
} from "@doxahq/contracts";
import type { Env } from "../../env";
import {
  ChangeProposalsRepository,
  type ChangeProposalRecord,
  type ChangeProposalsStore,
} from "../../repositories/change-proposals";
import {
  DoxabotSettingsRepository,
  type DoxabotAutomationContext,
  type DoxabotSettingsStore,
} from "../../repositories/doxabot-settings";
import {
  JobsRepository,
  previewConcurrencyKey,
  type DoxabotGenerationJobAdmission,
  type GenerationRerunSource,
  type PreviewRerunJobInput,
} from "../../repositories/jobs";
import {
  PreviewBaselinesRepository,
  type PreviewBaselinesStore,
} from "../../repositories/preview-baselines";
import type { PreviewAdmissionStop } from "../../repositories/preview-admission-guard";
import type { ChangeProposalSnapshot } from "./change-proposal-state";
import { GitHubPullRequestStateResolver } from "./github-pull-requests";
import {
  evaluateDoxabotEligibility,
  resolveDoxabotDeploymentPolicy,
  type DoxabotDeploymentPolicy,
} from "./eligibility";
import {
  mapDoxabotReviewRunState,
  reviewRunPresentationFor,
  ReviewRunsService,
  type ReviewRunReporter,
} from "./review-runs";
import {
  createDoxabotIdempotencyKey,
  resolveDoxabotExecutionConfig,
  type DoxabotJobQueue,
} from "./webhook-orchestrator";

export type PreviewRerunOutcome =
  | { outcome: "started"; job: GenerationJobDto }
  | { outcome: "already_active"; job: GenerationJobDto }
  | { outcome: "blocked"; reason: GenerationActionBlockedReason }
  | { outcome: "not_found" }
  | { outcome: "paused" }
  | { outcome: "active_conflict" }
  | { outcome: "dispatch_failed"; message: string };

export interface PreviewRerunJobsStore {
  isGenerationPaused(): Promise<boolean>;
  activeForConcurrencyKey(concurrencyKey: string): Promise<GenerationJobDto | null>;
  admitPreviewRerun(input: PreviewRerunJobInput): Promise<DoxabotGenerationJobAdmission>;
  markFailed(jobId: string, message: string): Promise<unknown>;
  addEvent(
    jobId: string,
    type: string,
    message: string,
    data?: Record<string, unknown>,
    source?: "system",
  ): Promise<unknown>;
}

export interface PreviewRerunDependencies {
  jobs: PreviewRerunJobsStore;
  settings: Pick<DoxabotSettingsStore, "getAutomationContext">;
  changeProposals: Pick<ChangeProposalsStore, "getByIdentity">;
  previewBaselines: PreviewBaselinesStore;
  queue: DoxabotJobQueue;
  reviewRuns: ReviewRunReporter;
  deploymentPolicy: DoxabotDeploymentPolicy;
  executionConfig: GenerationExecutionConfig;
  /** The pull request as GitHub has it now. */
  pullRequests: Pick<GitHubPullRequestStateResolver, "getCurrentForJob">;
}

const QUEUE_FAILED_MESSAGE = "Doxa could not queue the preview generation. Try again.";

/** The re-run answer when the pull request changes during the re-run. */
const BLOCKED_REASON_FOR_STOP: Record<PreviewAdmissionStop, GenerationActionBlockedReason> = {
  closed: "change_not_open",
  merged: "change_not_open",
  retargeted: "base_not_production",
  superseded: "superseded",
};

/**
 * Starts an ended preview run again, on the head of its pull request as it
 * is now. A webhook starts a preview once per head commit, so the run gets a
 * key of its own, and a new pull request check reports it.
 */
export class PreviewGenerationRerunService {
  constructor(private readonly deps: PreviewRerunDependencies) {}

  static fromEnv(env: Env): PreviewGenerationRerunService {
    return new PreviewGenerationRerunService({
      jobs: new JobsRepository(env),
      settings: new DoxabotSettingsRepository(env),
      changeProposals: new ChangeProposalsRepository(env),
      previewBaselines: new PreviewBaselinesRepository(env),
      queue: env.GENERATION_QUEUE,
      reviewRuns: ReviewRunsService.fromEnv(env),
      deploymentPolicy: resolveDoxabotDeploymentPolicy(env),
      executionConfig: resolveDoxabotExecutionConfig(env),
      pullRequests: GitHubPullRequestStateResolver.fromEnv(env),
    });
  }

  async rerun(previous: GenerationRerunSource): Promise<PreviewRerunOutcome> {
    const { sourceProvider: provider, changeExternalId, sourceInstallationExternalId } = previous;
    if (!provider || !changeExternalId || !sourceInstallationExternalId) {
      return { outcome: "not_found" };
    }
    if (await this.deps.jobs.isGenerationPaused()) return { outcome: "paused" };

    const proposal = await this.deps.changeProposals.getByIdentity({
      projectId: previous.projectId,
      provider,
      externalId: changeExternalId,
    });
    if (!proposal) return { outcome: "not_found" };

    const context = await this.deps.settings.getAutomationContext({
      provider,
      repositoryExternalId: proposal.repositoryExternalId,
      installationExternalId: proposal.installationExternalId,
    });
    if (!context || context.projectId !== previous.projectId) return { outcome: "not_found" };

    // A missed or late webhook leaves the record behind. The live state
    // decides; the record stands in when GitHub cannot answer, and the worker
    // checks the live state again.
    const live = await this.readLivePullRequest(context, proposal);
    const current = live ?? proposal;
    if (current.state !== "open" || current.draft) {
      return { outcome: "blocked", reason: "change_not_open" };
    }
    // A push that Doxa has not recorded yet: its own webhook starts the
    // preview of the new head, and a run of the recorded head would only be
    // superseded at its first step.
    if (live && live.headRevision !== proposal.headRevision) {
      return { outcome: "blocked", reason: "superseded" };
    }
    // The webhook previews only pull requests into the production branch. A
    // re-run follows the same rule, also after either branch changed.
    if (current.baseRef !== context.productionBranch) {
      return { outcome: "blocked", reason: "base_not_production" };
    }
    // A person asks for this run, so the project setting that turns
    // automatic previews off does not stop it. Previews must exist at all.
    const eligibility = evaluateDoxabotEligibility({
      deploymentPolicy: this.deps.deploymentPolicy,
      repository: { connected: true, visibility: context.repositoryVisibility },
      hasPublishedVersion: context.hasPublishedVersion,
      storedEnabled: context.storedEnabled,
    });
    if (!eligibility.available) return { outcome: "blocked", reason: "previews_unavailable" };

    const concurrencyKey = previewConcurrencyKey({
      projectId: previous.projectId,
      provider,
      changeExternalId,
    });
    const active = await this.deps.jobs.activeForConcurrencyKey(concurrencyKey);
    if (active) return { outcome: "already_active", job: active };

    const { executionConfig } = this.deps;
    const baseline = await this.deps.previewBaselines.findSuccessfulCompatiblePreview({
      projectId: previous.projectId,
      provider,
      changeExternalId,
    });
    const admission = await this.deps.jobs.admitPreviewRerun({
      projectId: previous.projectId,
      provider,
      sourceInstallationExternalId: proposal.installationExternalId,
      sourceAuthor: previous.sourceAuthor,
      changeProposalId: proposal.id,
      changeExternalId,
      baselineRevision: baseline
        ? baseline.sourceRevision
        : context.publishedBaseline?.sourceRevision ?? null,
      targetRevision: proposal.headRevision,
      sourceTreeHash: null,
      baselineVersionId: baseline?.versionId ?? context.publishedBaseline?.versionId ?? null,
      plannerModel: executionConfig.plannerModel,
      writerModel: executionConfig.writerModel,
      generationProfile: executionConfig.generationProfile,
      planningFingerprint: executionConfig.planningFingerprint,
      writingFingerprint: executionConfig.writingFingerprint,
      generatorFingerprint: executionConfig.generatorFingerprint,
      // The webhook key repeats for the same head commit; a re-run needs its own.
      idempotencyKey: `${createDoxabotIdempotencyKey({
        projectId: previous.projectId,
        provider,
        changeExternalId,
        headRevision: proposal.headRevision,
        generatorFingerprint: executionConfig.generatorFingerprint,
      })}:rerun:${crypto.randomUUID()}`,
      concurrencyKey,
      rerunOfJobId: previous.id,
      // A close, a base change or a push that Doxa records during the re-run
      // refuses it. A record that stays as read here does not: the live state
      // above already decided.
      guard: { seen: proposal, productionBranch: context.productionBranch },
    });
    if (admission.outcome === "stale_change") {
      return { outcome: "blocked", reason: BLOCKED_REASON_FOR_STOP[admission.reason] };
    }
    if (admission.outcome === "concurrency_conflict") {
      const winner = await this.deps.jobs.activeForConcurrencyKey(concurrencyKey);
      return winner ? { outcome: "already_active", job: winner } : { outcome: "active_conflict" };
    }

    const { job } = admission;
    const externalRunId = await this.createReviewRun(job, proposal.headRevision);
    try {
      await this.deps.queue.send({ jobId: job.id, projectId: previous.projectId, userId: context.ownerUserId });
    } catch {
      await this.deps.jobs.markFailed(job.id, QUEUE_FAILED_MESSAGE);
      if (externalRunId) await this.reportQueueFailure(job.id, externalRunId, proposal.headRevision);
      return { outcome: "dispatch_failed", message: QUEUE_FAILED_MESSAGE };
    }
    return { outcome: "started", job };
  }

  private async readLivePullRequest(
    context: DoxabotAutomationContext,
    proposal: ChangeProposalRecord,
  ): Promise<ChangeProposalSnapshot | null> {
    try {
      return await this.deps.pullRequests.getCurrentForJob({
        externalId: proposal.externalId,
        number: proposal.displayNumber,
        repositoryOwner: context.repositoryOwner,
        repositoryName: context.repositoryName,
        repositoryExternalId: context.repositoryExternalId,
        installationExternalId: context.installationExternalId,
      });
    } catch {
      return null;
    }
  }

  private async createReviewRun(job: GenerationJobDto, headRevision: string): Promise<string | null> {
    try {
      const result = await this.deps.reviewRuns.create(job.id, {
        ...reviewRunPresentationFor(job.status),
        detailsUrl: null,
        sourceRevision: headRevision,
      });
      return result.externalRunId;
    } catch (error) {
      await this.deps.jobs.addEvent(
        job.id,
        "review_run_create_failed",
        "Doxabot could not create the external review run.",
        { error: error instanceof Error ? error.message : String(error) },
        "system",
      );
      return null;
    }
  }

  private async reportQueueFailure(jobId: string, externalRunId: string, headRevision: string): Promise<void> {
    try {
      await this.deps.reviewRuns.update(jobId, {
        externalRunId,
        ...mapDoxabotReviewRunState("action_required"),
        title: "Documentation preview could not start",
        summary: "Doxa could not queue preview generation. A retry is required.",
        detailsUrl: null,
        sourceRevision: headRevision,
      });
    } catch (error) {
      await this.deps.jobs.addEvent(
        jobId,
        "review_run_update_failed",
        "Doxabot could not update the external review run.",
        { error: error instanceof Error ? error.message : String(error) },
        "system",
      );
    }
  }
}
