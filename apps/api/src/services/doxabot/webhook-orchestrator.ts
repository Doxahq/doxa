import type {
  CreateReviewRunInput,
  GenerateJobMessage,
  GenerationExecutionConfig,
  GenerationJobDto,
  NormalizedChangeProposalEvent,
  NormalizedSourceControlEvent,
  SourceControlEventParseResult,
  SourceProvider,
} from "@doxahq/contracts";
import type { Env } from "../../env";
import type { MergeGenerationScheduler } from "./merge-generations";
import {
  ChangeProposalsRepository,
  type ChangeProposalLifecycleState,
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
  type DoxabotGenerationJobsStore,
} from "../../repositories/jobs";
import {
  PreviewBaselinesRepository,
  type PreviewBaselinesStore,
} from "../../repositories/preview-baselines";
import {
  WebhookDeliveriesRepository,
  type WebhookDeliveryIdentity,
  type WebhookDeliveriesStore,
} from "../../repositories/webhook-deliveries";
import type {
  ChangeProposalSnapshot,
  ChangeProposalStateResolver,
} from "./change-proposal-state";
import {
  evaluateDoxabotEligibility,
  resolveDoxabotDeploymentPolicy,
  type DoxabotDeploymentPolicy,
} from "./eligibility";
import { parseGitHubEvent } from "./github-event-parser";
import { GitHubPullRequestStateResolver } from "./github-pull-requests";
import {
  mapDoxabotReviewRunState,
  ReviewRunsService,
  type ReviewRunReporter,
} from "./review-runs";
import {
  resolveGenerationExecutionConfig,
} from "../generation-execution-config";

export type DoxabotWebhookResult =
  | { outcome: "duplicate" }
  | { outcome: "ignored"; reason: string }
  | { outcome: "malformed"; reason: "invalid_payload" }
  | { outcome: "enqueued"; jobId: string }
  | { outcome: "replayed"; jobId: string }
  | { outcome: "enqueue_failed"; jobId: string };

export type DoxabotWebhookIngressResult =
  | { outcome: "claimed" }
  | { outcome: "duplicate" };

export interface ProcessGitHubWebhookInput {
  deliveryId: string;
  eventName: string;
  rawBody: string;
}

export interface DoxabotJobQueue {
  send(message: GenerateJobMessage): Promise<unknown>;
}

export interface DoxabotWebhookDependencies {
  deliveries: WebhookDeliveriesStore;
  settings: Pick<DoxabotSettingsStore, "getAutomationContext">;
  changeProposals: ChangeProposalsStore;
  jobs: DoxabotGenerationJobsStore;
  previewBaselines: PreviewBaselinesStore;
  queue: DoxabotJobQueue;
  reviewRuns: ReviewRunReporter;
  changeProposalState: ChangeProposalStateResolver;
  deploymentPolicy: DoxabotDeploymentPolicy;
  executionConfig: GenerationExecutionConfig;
  mergeTriggers: Pick<MergeGenerationScheduler, "recordMerge">;
}

export class DoxabotWebhookOrchestrator {
  constructor(private readonly dependencies: DoxabotWebhookDependencies) {}

  /** The caller builds the merge trigger, which needs its request context. */
  static fromEnv(
    env: Env,
    options: Pick<DoxabotWebhookDependencies, "mergeTriggers">,
  ): DoxabotWebhookOrchestrator {
    return new DoxabotWebhookOrchestrator({
      deliveries: new WebhookDeliveriesRepository(env),
      settings: new DoxabotSettingsRepository(env),
      changeProposals: new ChangeProposalsRepository(env),
      jobs: new JobsRepository(env),
      previewBaselines: new PreviewBaselinesRepository(env),
      queue: env.GENERATION_QUEUE,
      reviewRuns: ReviewRunsService.fromEnv(env),
      changeProposalState:
        GitHubPullRequestStateResolver.fromEnv(env),
      deploymentPolicy: resolveDoxabotDeploymentPolicy(env),
      executionConfig: resolveDoxabotExecutionConfig(env),
      mergeTriggers: options.mergeTriggers,
    });
  }

  async process(
    input: ProcessGitHubWebhookInput,
  ): Promise<DoxabotWebhookResult> {
    const ingress = await this.ingest(input);
    if (ingress.outcome === "duplicate") {
      return { outcome: "duplicate" };
    }
    return this.processDelivery({
      provider: "github",
      deliveryId: input.deliveryId,
    });
  }

  async ingest(
    input: ProcessGitHubWebhookInput,
  ): Promise<DoxabotWebhookIngressResult> {
    const payloadHash = await sha256(input.rawBody);
    const json = parseJson(input.rawBody);
    const parsed = json.ok
      ? parseGitHubEvent({
          eventName: input.eventName,
          deliveryId: input.deliveryId,
          payload: json.value,
        })
      : malformedParseResult();
    const metadata = extractDeliveryMetadata(json.ok ? json.value : null, parsed);
    const identity: { provider: SourceProvider; deliveryId: string } = {
      provider: "github",
      deliveryId: input.deliveryId,
    };
    const claim = await this.dependencies.deliveries.claimDelivery({
      ...identity,
      eventName: input.eventName,
      action: metadata.action,
      repositoryExternalId: metadata.repositoryExternalId,
      payloadHash,
      normalizedEvent: parsed,
    });
    return { outcome: claim };
  }

  async processDelivery(
    identity: WebhookDeliveryIdentity,
  ): Promise<DoxabotWebhookResult> {
    try {
      const parsed =
        await this.dependencies.deliveries.getNormalizedEvent(identity);
      if (!parsed) {
        throw new Error("Claimed webhook delivery was not found.");
      }
      return await this.processClaimed(identity, parsed);
    } catch (caught) {
      await this.dependencies.deliveries.markFailed({
        ...identity,
        errorCode: "processing_failed",
      });
      throw caught;
    }
  }

  private async processClaimed(
    identity: WebhookDeliveryIdentity,
    parsed: SourceControlEventParseResult,
  ): Promise<DoxabotWebhookResult> {
    if (parsed.outcome === "malformed") {
      await this.dependencies.deliveries.markFailed({
        ...identity,
        errorCode: parsed.reason,
      });
      return { outcome: "malformed", reason: parsed.reason };
    }

    if (parsed.outcome === "irrelevant") {
      return this.ignore(identity, parsed.reason);
    }

    if (parsed.events.length !== 1) {
      return this.ignore(identity, "repository_lifecycle_deferred");
    }

    const [event] = parsed.events;
    const context = await this.dependencies.settings.getAutomationContext({
      provider: event.repository.provider,
      repositoryExternalId: event.repository.externalId,
      installationExternalId: event.repository.installationExternalId,
    });
    if (!context) {
      return this.ignore(identity, "project_not_found");
    }

    const eligibility = evaluateDoxabotEligibility({
      deploymentPolicy: this.dependencies.deploymentPolicy,
      repository: {
        connected: true,
        visibility: event.repository.visibility,
      },
      hasPublishedVersion: context.publishedVersionId !== null,
      storedEnabled: context.storedEnabled,
    });
    if (!eligibility.available) {
      return this.ignore(identity, eligibility.reason);
    }
    if (!eligibility.enabled) {
      return this.ignore(identity, "project_disabled");
    }

    switch (event.kind) {
      case "change_proposal":
        return this.processChangeProposal(identity, context, event);
      case "default_branch_push":
        return this.ignore(identity, "default_branch_push_deferred");
      case "repository_lifecycle":
        return this.ignore(identity, "repository_lifecycle_deferred");
    }
  }

  private async processChangeProposal(
    identity: WebhookDeliveryIdentity,
    context: DoxabotAutomationContext,
    event: NormalizedChangeProposalEvent,
  ): Promise<DoxabotWebhookResult> {
    if (event.change.baseRef !== event.repository.defaultBranch) {
      return this.ignore(identity, "non_default_base");
    }

    const lifecycleState = lifecycleStateFor(event);
    const ensured = await this.dependencies.changeProposals.ensure({
      projectId: context.projectId,
      provider: event.repository.provider,
      repositoryExternalId: event.repository.externalId,
      installationExternalId:
        event.repository.installationExternalId,
      externalId: event.change.externalId,
      displayNumber: event.change.number,
      draft: event.change.draft,
      state: lifecycleState,
      defaultBranch: event.repository.defaultBranch,
      baseRef: event.change.baseRef,
      baseRevision: event.change.baseRevision.commitSha,
      headRevision: event.change.headRevision.commitSha,
      sourceUpdatedAt: new Date(event.change.sourceUpdatedAt),
    });

    const proposal = await this.applyChangeProposalEvent(
      ensured,
      context,
      event,
    );
    if (typeof proposal === "string") {
      return this.ignore(identity, proposal);
    }

    // A merge into the default branch feeds the merge trigger, which may
    // start a production run that goes to a review.
    if (lifecycleState === "merged") {
      await this.dependencies.mergeTriggers.recordMerge({
        projectId: context.projectId,
        mergeTrigger: context.mergeTrigger,
        changeExternalId: event.change.externalId,
        changeNumber: event.change.number,
        mergedAt: new Date(event.change.sourceUpdatedAt),
      });
    }

    if (lifecycleState !== "open") {
      return this.ignore(
        identity,
        lifecycleState === "merged" ? "change_merged" : "change_closed",
      );
    }
    if (event.change.draft || event.action === "converted_to_draft") {
      return this.ignore(identity, "draft_change");
    }

    return this.enqueuePreview(identity, context, event, proposal);
  }

  private async applyChangeProposalEvent(
    ensured: {
      outcome: "created" | "existing";
      proposal: ChangeProposalRecord;
    },
    context: DoxabotAutomationContext,
    event: NormalizedChangeProposalEvent,
  ): Promise<ChangeProposalRecord | string> {
    let current = ensured;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const resolved = await this.resolveAmbiguousEvent(
        current,
        context,
        event,
      );
      if (typeof resolved === "string") return resolved;

      const staleReason = getStaleEventReason(current, resolved);
      if (staleReason) return staleReason;

      const proposal =
        await this.dependencies.changeProposals.compareAndSetHead({
          proposalId: current.proposal.id,
          expectedHeadRevision: current.proposal.headRevision,
          expectedSourceUpdatedAt: current.proposal.sourceUpdatedAt,
          headRevision: resolved.change.headRevision.commitSha,
          baseRevision: resolved.change.baseRevision.commitSha,
          defaultBranch: resolved.repository.defaultBranch,
          baseRef: resolved.change.baseRef,
          installationExternalId:
            resolved.repository.installationExternalId,
          draft: resolved.change.draft,
          state: lifecycleStateFor(resolved),
          sourceUpdatedAt: new Date(resolved.change.sourceUpdatedAt),
        });
      if (proposal) return proposal;

      const refreshed =
        await this.dependencies.changeProposals.getByIdentity({
          projectId: current.proposal.projectId,
          provider: current.proposal.provider,
          externalId: current.proposal.externalId,
        });
      if (!refreshed) return "concurrent_change_update";
      current = { outcome: "existing", proposal: refreshed };
    }

    return "concurrent_change_update";
  }

  private async resolveAmbiguousEvent(
    current: {
      outcome: "created" | "existing";
      proposal: ChangeProposalRecord;
    },
    context: DoxabotAutomationContext,
    event: NormalizedChangeProposalEvent,
  ): Promise<NormalizedChangeProposalEvent | string> {
    if (current.outcome === "created") return event;

    const eventUpdatedAt = Date.parse(event.change.sourceUpdatedAt);
    if (
      eventUpdatedAt !== current.proposal.sourceUpdatedAt.getTime() ||
      snapshotsEqual(
        snapshotForProposal(current.proposal),
        snapshotForEvent(event),
      )
    ) {
      return event;
    }

    const providerState =
      await this.dependencies.changeProposalState.getCurrent({
        context,
        event,
      });
    if (!snapshotsEqual(providerState, snapshotForEvent(event))) {
      return "stale_change_event";
    }

    return {
      ...event,
      change: {
        ...event.change,
        sourceUpdatedAt: providerState.sourceUpdatedAt.toISOString(),
      },
    };
  }

  private async enqueuePreview(
    identity: WebhookDeliveryIdentity,
    context: DoxabotAutomationContext,
    event: NormalizedChangeProposalEvent,
    proposal: ChangeProposalRecord,
  ): Promise<DoxabotWebhookResult> {
    const idempotencyKey = createDoxabotIdempotencyKey({
      projectId: context.projectId,
      provider: event.repository.provider,
      changeExternalId: event.change.externalId,
      headRevision: event.change.headRevision.commitSha,
      generatorFingerprint:
        this.dependencies.executionConfig.generatorFingerprint,
    });
    const concurrencyKey = previewConcurrencyKey({
      projectId: context.projectId,
      provider: event.repository.provider,
      changeExternalId: event.change.externalId,
    });
    const previewBaseline =
      await this.dependencies.previewBaselines
        .findSuccessfulCompatiblePreview({
          projectId: context.projectId,
          provider: event.repository.provider,
          changeExternalId: event.change.externalId,
        });
    const admissionInput = {
      projectId: context.projectId,
      provider: event.repository.provider,
      sourceInstallationExternalId:
        event.repository.installationExternalId,
      sourceAuthor: event.change.author ?? null,
      changeProposalId: proposal.id,
      changeExternalId: event.change.externalId,
      baselineRevision:
        previewBaseline?.sourceRevision ??
        context.publishedSourceRevision,
      targetRevision: event.change.headRevision.commitSha,
      sourceTreeHash: null,
      baselineVersionId:
        previewBaseline?.versionId ?? context.publishedVersionId,
      plannerModel:
        this.dependencies.executionConfig.plannerModel,
      writerModel:
        this.dependencies.executionConfig.writerModel,
      generationProfile:
        this.dependencies.executionConfig.generationProfile,
      planningFingerprint:
        this.dependencies.executionConfig.planningFingerprint,
      writingFingerprint:
        this.dependencies.executionConfig.writingFingerprint,
      generatorFingerprint:
        this.dependencies.executionConfig.generatorFingerprint,
      idempotencyKey,
      concurrencyKey,
      deliveryId: identity.deliveryId,
    };
    let active = null;
    let admission =
      await this.dependencies.jobs.admitDoxabotJob(admissionInput);
    if (admission.outcome === "concurrency_conflict") {
      active = await this.dependencies.jobs.activeForConcurrencyKey(
        concurrencyKey,
      );
      if (!active) {
        throw new Error(
          "Preview admission conflicted without an active job.",
        );
      }
      await this.dependencies.jobs.markCancelled(
        active.id,
        "Superseded by a newer pull request head.",
        "doxabot_superseded",
        { targetRevision: event.change.headRevision.commitSha },
      );
      admission =
        await this.dependencies.jobs.admitDoxabotJob(admissionInput);
    }
    if (admission.outcome === "concurrency_conflict") {
      throw new Error("Preview admission remained conflicted.");
    }
    if (active) {
      await this.dependencies.jobs.linkSupersededJob({
        supersededJobId: active.id,
        supersedingJobId: admission.job.id,
      });
    }

    const externalReviewRunId = await this.reconcileReviewRun(
      admission.job,
      event,
    );

    if (!admission.queuePublished) {
      try {
        await this.dependencies.queue.send({
          jobId: admission.job.id,
          projectId: context.projectId,
          userId: context.ownerUserId,
        });
        const recorded =
          await this.dependencies.deliveries.markGenerationJobPublished(
            admission.job.id,
          );
        if (!recorded) {
          throw new Error(
            "Queue publication could not be recorded.",
          );
        }
      } catch {
        if (externalReviewRunId) {
          await this.updateReviewRunForQueueFailure(
            admission.job.id,
            externalReviewRunId,
            event,
          );
        }
        await this.dependencies.deliveries.markEnqueueFailed({
          ...identity,
          errorCode: "queue_publication_failed",
        });
        return {
          outcome: "enqueue_failed",
          jobId: admission.job.id,
        };
      }
    }

    await this.dependencies.deliveries.markProcessed(identity);
    return {
      outcome:
        admission.outcome === "replayed" ? "replayed" : "enqueued",
      jobId: admission.job.id,
    };
  }

  private async reconcileReviewRun(
    job: GenerationJobDto,
    event: NormalizedChangeProposalEvent,
  ): Promise<string | null> {
    try {
      const result = await this.dependencies.reviewRuns.create(job.id, {
        ...reviewRunPresentationFor(job.status),
        detailsUrl: null,
        sourceRevision: event.change.headRevision.commitSha,
      });
      return result.externalRunId;
    } catch (error) {
      await this.dependencies.jobs.addEvent(
        job.id,
        "review_run_create_failed",
        "Doxabot could not create the external review run.",
        { error: errorMessage(error) },
        "system",
      );
      return null;
    }
  }

  private async updateReviewRunForQueueFailure(
    jobId: string,
    externalRunId: string,
    event: NormalizedChangeProposalEvent,
  ): Promise<void> {
    try {
      await this.dependencies.reviewRuns.update(jobId, {
        externalRunId,
        ...mapDoxabotReviewRunState("action_required"),
        title: "Documentation preview could not start",
        summary:
          "Doxa could not queue preview generation. A retry is required.",
        detailsUrl: null,
        sourceRevision: event.change.headRevision.commitSha,
      });
    } catch (error) {
      await this.dependencies.jobs.addEvent(
        jobId,
        "review_run_update_failed",
        "Doxabot could not update the external review run.",
        { error: errorMessage(error) },
        "system",
      );
    }
  }

  private async ignore(
    identity: WebhookDeliveryIdentity,
    reason: string,
  ): Promise<DoxabotWebhookResult> {
    await this.dependencies.deliveries.markIgnored({ ...identity, reason });
    return { outcome: "ignored", reason };
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

export function resolveDoxabotGeneratorFingerprint(
  env: Pick<
    Env,
    | "DOXABOT_GENERATOR_FINGERPRINT"
    | "DOXA_AGENT_MODEL"
    | "DOXA_GENERATION_PROFILE"
  >,
): string {
  return resolveDoxabotExecutionConfig(env).generatorFingerprint;
}

export function resolveDoxabotExecutionConfig(
  env: Pick<
    Env,
    | "DOXABOT_GENERATOR_FINGERPRINT"
    | "DOXA_AGENT_MODEL"
    | "DOXA_GENERATION_PROFILE"
  >,
): GenerationExecutionConfig {
  return resolveGenerationExecutionConfig(env);
}

export function createDoxabotIdempotencyKey(input: {
  projectId: string;
  provider: SourceProvider;
  changeExternalId: string;
  headRevision: string;
  generatorFingerprint: string;
}): string {
  return [
    "doxabot",
    input.projectId,
    input.provider,
    input.changeExternalId,
    input.headRevision,
    input.generatorFingerprint,
  ].join(":");
}

function lifecycleStateFor(
  event: NormalizedChangeProposalEvent,
): ChangeProposalLifecycleState {
  if (event.action !== "closed") return "open";
  return event.change.merged ? "merged" : "closed";
}

function getStaleEventReason(
  ensured: {
    outcome: "created" | "existing";
    proposal: ChangeProposalRecord;
  },
  event: NormalizedChangeProposalEvent,
): string | null {
  if (ensured.outcome === "created") return null;
  const sourceUpdatedAt = Date.parse(event.change.sourceUpdatedAt);
  const currentUpdatedAt = ensured.proposal.sourceUpdatedAt.getTime();
  if (sourceUpdatedAt < currentUpdatedAt) {
    return "stale_change_event";
  }
  if (
    ensured.proposal.state !== "open" &&
    event.action !== "reopened" &&
    event.action !== "closed"
  ) {
    return "stale_change_event";
  }
  if (
    event.action === "opened" &&
    ensured.proposal.headRevision !== event.change.headRevision.commitSha
  ) {
    return "stale_opened_event";
  }
  return null;
}

function snapshotForProposal(
  proposal: ChangeProposalRecord,
): ChangeProposalSnapshot {
  return {
    externalId: proposal.externalId,
    number: proposal.displayNumber,
    draft: proposal.draft,
    state: proposal.state,
    baseRef: proposal.baseRef,
    baseRevision: proposal.baseRevision,
    headRevision: proposal.headRevision,
    sourceUpdatedAt: proposal.sourceUpdatedAt,
  };
}

function snapshotForEvent(
  event: NormalizedChangeProposalEvent,
): ChangeProposalSnapshot {
  return {
    externalId: event.change.externalId,
    number: event.change.number,
    draft: event.change.draft,
    state: lifecycleStateFor(event),
    baseRef: event.change.baseRef,
    baseRevision: event.change.baseRevision.commitSha,
    headRevision: event.change.headRevision.commitSha,
    sourceUpdatedAt: new Date(event.change.sourceUpdatedAt),
  };
}

function snapshotsEqual(
  left: ChangeProposalSnapshot,
  right: ChangeProposalSnapshot,
): boolean {
  return (
    left.externalId === right.externalId &&
    left.number === right.number &&
    left.draft === right.draft &&
    left.state === right.state &&
    left.baseRef === right.baseRef &&
    left.baseRevision === right.baseRevision &&
    left.headRevision === right.headRevision
  );
}

function extractDeliveryMetadata(
  payload: unknown,
  parsed: SourceControlEventParseResult,
): {
  action: string | null;
  repositoryExternalId: string | null;
} {
  const actionValue = property(payload, "action");
  const normalizedRepository =
    parsed.outcome === "normalized" ? parsed.events[0]?.repository : undefined;
  const rawRepositoryId = property(property(payload, "repository"), "id");

  return {
    action: typeof actionValue === "string" ? actionValue : null,
    repositoryExternalId:
      normalizedRepository?.externalId ??
      (typeof rawRepositoryId === "number" ||
      typeof rawRepositoryId === "string"
        ? String(rawRepositoryId)
        : null),
  };
}

function property(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? Reflect.get(value, key)
    : undefined;
}

function parseJson(
  value: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

function malformedParseResult(): SourceControlEventParseResult {
  return { outcome: "malformed", reason: "invalid_payload" };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown review-run error.";
}
