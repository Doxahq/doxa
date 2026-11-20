import { WorkerEntrypoint } from "cloudflare:workers";
import { GENERATION_RESUMED_EVENT_TYPE } from "@doxahq/contracts";
import type {
  AddJobEventInput,
  CompleteJobOutputInput,
  CreateReviewRunInput,
  InternalApiRpc,
  PublishJobInput,
  UpdateReviewRunInput,
  GenerationRepairDiagnostic,
  GenerationUsageRecord,
  MarkJobStoppedInput,
  StoreGenerationSiteAssetInput,
  StoreGenerationSiteAssetResult,
} from "@doxahq/contracts";
import { markJobStoppedInputSchema } from "@doxahq/contracts";
import type { GenerationInternalApi } from "@doxahq/generation";
import type { Env } from "../env";
import { DocsRepository } from "../repositories/docs";
import { GitHubRepository } from "../repositories/github";
import { JobsRepository } from "../repositories/jobs";
import { ProjectsRepository } from "../repositories/projects";
import { SiteAssetsService } from "./site-assets/service";
import {
  GenerationObservabilityRepository,
  toGenerationDiagnosticMetadata,
} from "../repositories/generation-observability";
import { resolveDocsHost as resolveDocsHostForEnv } from "./docs-host-resolution";
import { createInstallationAccessToken } from "./github-app";
import { ReviewRunsService } from "./doxabot/review-runs";
import {
  CANCELLED_PREVIEW_CHECK,
  closePreviewCheck,
  SUPERSEDED_PREVIEW_CHECK,
} from "./generation-cancellation";
import { generationNotifierFromEnv } from "./email/notifications";
import { GitHubPullRequestStateResolver } from "./doxabot/github-pull-requests";
import { withGenerationSiteConfig } from "./generation-site-config";
import { withRunInputs } from "./generation-run-inputs";
import { withDoxabotInstructions } from "./doxabot/generation-instructions";
import { createRepositoryReadAccess } from "./repository-read-access";
import { GenerationReviewService } from "./generation-reviews/review-service";
import { PendingMergesRepository } from "../repositories/pending-merges";
import { generationMeteringFromEnv } from "./billing/generation-metering-env";
import type { GenerationMetering, RunOutcome } from "./billing/generation-metering";
import { closeStoppedPreviewCheck } from "./billing/stopped-preview-check";
import {
  assertSafeArtifactKey,
  createR2DocsArtifactReader,
} from "./docs-content/store";

export class InternalApi extends WorkerEntrypoint<Env> implements InternalApiRpc {
  resolveDocsSite(projectSlug: string) {
    return resolveDocsSite(this.env, projectSlug);
  }

  resolveDocsProject(projectId: string) {
    return resolveDocsProject(this.env, projectId);
  }

  resolveDocsHost(hostname: string) {
    return resolveDocsHost(this.env, hostname);
  }

  async readDocsArtifact(path: string) {
    const object = await createR2DocsArtifactReader(this.env.DOCS_BUCKET).get(
      assertSafeArtifactKey(path),
    );
    if (!object) return null;
    return {
      text: await object.text(),
      contentType: object.httpMetadata?.contentType ?? "text/plain; charset=utf-8",
    };
  }

  getGenerationContext(projectId: string) {
    return getGenerationContext(this.env, projectId);
  }

  getGenerationExecutionContext(jobId: string) {
    return getGenerationExecutionContext(this.env, jobId);
  }

  getCurrentChangeProposalState(jobId: string) {
    return getCurrentChangeProposalState(this.env, jobId);
  }

  async createInstallationAccessToken(installationId: string) {
    const token = await createInstallationAccessToken(this.env, installationId);
    return token.token;
  }

  async createRepositoryReadToken(projectId: string) {
    const access = await createRepositoryReadAccess(this.env, projectId);
    return access.token;
  }

  storeGenerationSiteAsset(input: StoreGenerationSiteAssetInput) {
    return storeGenerationSiteAsset(this.env, input);
  }

  createModelAccessToken() {
    return this.env.MODEL_TOKEN_BROKER?.getToken() ?? Promise.resolve(null);
  }

  markJobRunning(jobId: string) {
    return markJobRunning(this.env, jobId);
  }

  markJobFailed(jobId: string, message: string) {
    return markJobFailed(this.env, jobId, message);
  }

  markJobCancelled(jobId: string, message: string) {
    return markJobCancelled(this.env, jobId, message);
  }

  markJobSuperseded(jobId: string, message: string) {
    return markJobSuperseded(this.env, jobId, message);
  }

  isJobActive(jobId: string) {
    return isJobActive(this.env, jobId);
  }

  getJobStopReason(jobId: string) {
    return generationMeteringFromEnv(this.env).stopReason(jobId);
  }

  markJobStopped(jobId: string, input: MarkJobStoppedInput) {
    return markJobStopped(this.env, jobId, input);
  }

  getGenerationResumedAt(jobId: string) {
    return new JobsRepository(this.env).latestEventAt(jobId, GENERATION_RESUMED_EVENT_TYPE);
  }

  getGenerationControl() {
    return getGenerationControl(this.env);
  }

  listStaleGenerationJobs(input: { queuedStaleSeconds: number; runningStaleSeconds: number }) {
    return listStaleGenerationJobs(this.env, input);
  }

  addJobEvent(jobId: string, input: AddJobEventInput) {
    return addJobEvent(this.env, jobId, input);
  }

  getGenerationDatabaseCompatibility() {
    return new GenerationObservabilityRepository(this.env)
      .getDatabaseCompatibility();
  }

  recordGenerationUsage(record: GenerationUsageRecord) {
    return recordGenerationUsage(this.env, record);
  }

  recordGenerationDiagnostic(
    diagnostic: GenerationRepairDiagnostic,
    draftKey: string,
  ) {
    return new GenerationObservabilityRepository(this.env)
      .recordDiagnostic(
        toGenerationDiagnosticMetadata(diagnostic, draftKey),
      );
  }

  getGenerationUsageSummary(jobId: string) {
    return new GenerationObservabilityRepository(this.env)
      .getUsageSummary(jobId);
  }

  deleteExpiredGenerationObservability(
    nowIso: string,
    limit: number,
  ) {
    return new GenerationObservabilityRepository(this.env)
      .deleteExpired(new Date(nowIso), limit);
  }

  async publishJobOutput(jobId: string, input: PublishJobInput) {
    return publishJobOutput(this.env, jobId, input);
  }

  completeJobOutput(
    jobId: string,
    input: CompleteJobOutputInput,
  ) {
    return completeJobOutput(this.env, jobId, input);
  }

  createReviewRun(jobId: string, input: CreateReviewRunInput) {
    return createReviewRun(this.env, jobId, input);
  }

  updateReviewRun(jobId: string, input: UpdateReviewRunInput) {
    return updateReviewRun(this.env, jobId, input);
  }
}

export function createLocalGenerationInternalApi(env: Env): GenerationInternalApi {
  return {
    getGenerationContext: (projectId) => getGenerationContext(env, projectId),
    createInstallationAccessToken: async (installationId) => {
      const token = await createInstallationAccessToken(env, installationId);
      return token.token;
    },
    markJobRunning: (jobId) => markJobRunning(env, jobId),
    markJobFailed: (jobId, message) => markJobFailed(env, jobId, message),
    markJobCancelled: (jobId, message) => markJobCancelled(env, jobId, message),
    isJobActive: (jobId) => isJobActive(env, jobId),
    getGenerationControl: () => getGenerationControl(env),
    listStaleGenerationJobs: (input) => listStaleGenerationJobs(env, input),
    addJobEvent: (jobId, type, message, data, source) =>
      addJobEvent(env, jobId, { type, message, data, source }).then(() => undefined),
    publishJobOutput: (input) => publishJobOutput(env, input.jobId, input),
  };
}

function resolveDocsSite(env: Env, projectSlug: string) {
  return new DocsRepository(env).resolveBySlug(projectSlug);
}

function resolveDocsProject(env: Env, projectId: string) {
  return new DocsRepository(env).resolveByProjectId(projectId);
}

function resolveDocsHost(env: Env, hostname: string) {
  return resolveDocsHostForEnv(env, hostname);
}

async function getGenerationContext(env: Env, projectId: string) {
  return withDoxabotInstructions(
    env,
    await withGenerationSiteConfig(
      env,
      await new GitHubRepository(env).getGenerationContext(projectId),
    ),
  );
}

async function getGenerationExecutionContext(env: Env, jobId: string) {
  return withDoxabotInstructions(
    env,
    await withGenerationSiteConfig(
      env,
      await withRunInputs(
        env,
        await new JobsRepository(env).getGenerationExecutionContext(jobId),
      ),
    ),
  );
}

async function getCurrentChangeProposalState(
  env: Env,
  jobId: string,
) {
  const context =
    await new JobsRepository(env).getGenerationExecutionContext(jobId);
  if (
    !context?.changeProposal ||
    context.job.sourceProvider !== "github" ||
    !context.job.sourceInstallationExternalId
  ) {
    return null;
  }
  const state = await GitHubPullRequestStateResolver.fromEnv(
    env,
  ).getCurrentForJob({
    externalId: context.changeProposal.externalId,
    number: context.changeProposal.number,
    repositoryOwner: context.sourceRepository.owner,
    repositoryName: context.sourceRepository.name,
    repositoryExternalId: context.sourceRepository.externalId,
    installationExternalId:
      context.job.sourceInstallationExternalId,
  });
  return {
    ...state,
    sourceUpdatedAt: state.sourceUpdatedAt.toISOString(),
  };
}

async function markJobRunning(env: Env, jobId: string): Promise<void> {
  await new JobsRepository(env).markRunning(jobId);
}

async function markJobFailed(env: Env, jobId: string, message: string): Promise<void> {
  const failed = await new JobsRepository(env).markFailed(jobId, message);
  if (failed) await settleRun(env, jobId, "failed");
  if (failed) await generationNotifierFromEnv(env).finished(jobId, "failed", message);
}

/** Billing spec 10.5 step 5. The meter never throws here: the job has ended either way. */
function settleRun(env: Env, jobId: string, outcome?: RunOutcome, metering?: GenerationMetering): Promise<void> {
  return (metering ?? generationMeteringFromEnv(env)).settle(jobId, outcome);
}

/** Billing spec 10.5 step 2: the usage record first, then the meter, keyed by the call ID. */
async function recordGenerationUsage(env: Env, record: GenerationUsageRecord): Promise<void> {
  await new GenerationObservabilityRepository(env).recordUsage(record);
  await generationMeteringFromEnv(env).accrue({
    jobId: record.jobId,
    callId: record.callId,
    costUsd: record.costUsd,
  });
}

/**
 * Billing spec 10.6: the worker ends a run that the meter stopped. The run
 * keeps its finished page checkpoints, a preview's check finishes `neutral`
 * (it never fails the customer's CI), and the settle charges base + usage.
 */
async function markJobStopped(env: Env, jobId: string, rawInput: MarkJobStoppedInput): Promise<void> {
  const input = markJobStoppedInputSchema.parse(rawInput);
  const jobs = new JobsRepository(env);
  if (!(await jobs.markStoppedCredits(jobId, input))) return;
  await settleRun(env, jobId, "stopped");
  await closeStoppedPreviewCheck(env, jobs, ReviewRunsService.fromEnv(env), { jobId, reason: input.reason });
}

/**
 * The worker cancels its own job, for example while generation is paused,
 * then stops without touching the check. The check closes here.
 */
async function markJobCancelled(env: Env, jobId: string, message: string): Promise<void> {
  const jobs = new JobsRepository(env);
  const check = { title: CANCELLED_PREVIEW_CHECK.title, summary: message };
  if (!(await jobs.markCancelled(jobId, message, "generation_cancelled", undefined, check))) return;
  await settleRun(env, jobId, "cancelled");
  await closePreviewCheck(jobs, ReviewRunsService.fromEnv(env), { jobId, message, check });
}

/** The worker found a newer pull request state; it writes the check itself. */
async function markJobSuperseded(
  env: Env,
  jobId: string,
  message: string,
): Promise<void> {
  const superseded = await new JobsRepository(env).markCancelled(
    jobId,
    message,
    "doxabot_superseded",
    undefined,
    SUPERSEDED_PREVIEW_CHECK,
  );
  if (superseded) await settleRun(env, jobId, "superseded");
}

/**
 * False once the job ended, and, with `BILLING_ENFORCEMENT=on`, once the
 * credit meter stopped the run (billing spec 10.5 step 4). The worker then
 * asks `getJobStopReason` and ends the run as `stopped_credits`.
 */
/**
 * The project comes from the job, never from the caller, and only an active
 * job can store an asset.
 */
async function storeGenerationSiteAsset(
  env: Env,
  input: StoreGenerationSiteAssetInput,
): Promise<StoreGenerationSiteAssetResult> {
  if (input.kind !== "logo" && input.kind !== "favicon") {
    throw new Error("Unsupported generation site asset kind.");
  }
  if (!(await isJobActive(env, input.jobId))) {
    throw new Error("The generation job is not active.");
  }
  const projectId = await new JobsRepository(env).findProjectId(input.jobId);
  if (!projectId) throw new Error("Generation job not found.");
  const site = await new ProjectsRepository(env).getDocsSiteForProject(projectId);
  if (!site) throw new Error("Docs site not found.");
  const stored = await SiteAssetsService.fromEnv(env).uploadForGeneration(
    projectId,
    site.siteId,
    input.kind,
    input.bytes,
  );
  return { ref: stored.ref };
}

async function isJobActive(env: Env, jobId: string): Promise<boolean> {
  if (!(await new JobsRepository(env).isActive(jobId))) return false;
  const metering = generationMeteringFromEnv(env);
  if (metering.mode !== "on") return true;
  return (await metering.stopReason(jobId)) === null;
}

function getGenerationControl(env: Env) {
  return new JobsRepository(env).getGenerationControl();
}

function listStaleGenerationJobs(
  env: Env,
  input: { queuedStaleSeconds: number; runningStaleSeconds: number },
) {
  return new JobsRepository(env).listStaleJobs(input);
}

function addJobEvent(env: Env, jobId: string, input: AddJobEventInput) {
  return new JobsRepository(env).addEvent(jobId, input.type, input.message, input.data, input.source);
}

async function publishJobOutput(env: Env, jobId: string, input: PublishJobInput) {
  const version = await new DocsRepository(env).publishJob({
    jobId,
    artifactPrefix: input.artifactPrefix,
    manifestPath: input.manifestPath,
  });
  await settleRun(env, jobId, "succeeded");
  await generationNotifierFromEnv(env).finished(jobId, "succeeded");

  return { versionId: version.id };
}

/**
 * A repeated completion is safe: the version, the review, and the email each
 * exist once for a job. A production run that waits for review opens its
 * review before the email goes out, so the email link shows it.
 */
async function completeJobOutput(
  env: Env,
  jobId: string,
  input: CompleteJobOutputInput,
) {
  const completed = await new DocsRepository(env).completeJob(jobId, input, env);
  if (input.publicationMode === "publish") {
    await GenerationReviewService.fromEnv(env).openForRun(jobId, {
      ownedPageFlags: input.ownedPageFlags,
      pageSources: input.pageSources,
    });
    // The run covers every pull request merged before it started.
    await new PendingMergesRepository(env).clearCoveredByJob(jobId);
  }
  // Decision D12: a Doxabot run that changed no page pays the usage only.
  await settleRun(env, jobId, input.regeneratedPageCount === 0 ? "no_change" : "pages_changed");
  await generationNotifierFromEnv(env).finished(jobId, "succeeded");
  return completed;
}

function createReviewRun(
  env: Env,
  jobId: string,
  input: CreateReviewRunInput,
) {
  return ReviewRunsService.fromEnv(env).create(jobId, input);
}

function updateReviewRun(
  env: Env,
  jobId: string,
  input: UpdateReviewRunInput,
) {
  return ReviewRunsService.fromEnv(env).update(jobId, input);
}
