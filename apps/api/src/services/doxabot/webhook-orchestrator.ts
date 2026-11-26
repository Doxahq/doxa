import {
  normalizeBotLogin,
  type GenerateJobMessage,
  type GenerationExecutionConfig,
  type GenerationJobDto,
  type NormalizedChangeProposalEvent,
  type NormalizedReviewRunRetryEvent,
  type NormalizedInstallationLifecycleEvent,
  type NormalizedRepositoryLifecycleEvent,
  type SourceControlEventParseResult,
  type SourceProvider,
} from "@doxahq/contracts";
import type { ProductAnalytics } from "@doxahq/analytics";
import type { Env } from "../../env";
import { productAnalyticsOf } from "../analytics/product-analytics";
import { captureGenerationStarted } from "../generation-analytics";
import { fetchRepositoryDefaultBranch } from "../github-app";
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
  GitHubLifecycleRepository,
  type GitHubInstallationStatus,
  type RepositoryLifecycleStore,
} from "../../repositories/github-lifecycle";
import {
  JobsRepository,
  previewConcurrencyKey,
  type DoxabotGenerationJobsStore,
} from "../../repositories/jobs";
import {
  PreviewBaselinesRepository,
  type PreviewBaselinesStore,
} from "../../repositories/preview-baselines";
import type { PreviewStopReason } from "../../repositories/preview-admission-guard";
import {
  PreviewChannelClosureRepository,
  type PreviewChannelCloser,
} from "../../repositories/preview-channel-closure";
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
import type { PreviewCheckRetryService } from "./preview-check-retry";
import { GitHubPullRequestStateResolver } from "./github-pull-requests";
import {
  mapDoxabotReviewRunState,
  reviewRunPresentationFor,
  ReviewRunsService,
  STOPPED_CREDITS_CHECK,
  type ReviewRunReporter,
} from "./review-runs";
import {
  resolveGenerationExecutionConfig,
} from "../generation-execution-config";
import { CreditsExhaustedError, PlanLimitError } from "@doxahq/billing";
import type { BillingRefusal } from "../billing/generation-metering";
import { meteredActionOf, requiredFeaturesOf, runModels } from "../billing/generation-metering";
import { generationMeteringFromEnv } from "../billing/generation-metering-env";
import { billingPageUrlForProject } from "../billing/stopped-preview-check";
import { checkRepositorySize, maxRepositorySizeKbFromEnv } from "../repository-size";
import {
  cancelGenerationJob,
  finishGenerationCancellation,
  SUPERSEDED_PREVIEW_CHECK,
  type GenerationCancellationInput,
} from "../generation-cancellation";

export type DoxabotWebhookResult =
  | { outcome: "duplicate" }
  | { outcome: "ignored"; reason: string }
  | { outcome: "malformed"; reason: "invalid_payload" }
  | { outcome: "enqueued"; jobId: string }
  | { outcome: "replayed"; jobId: string }
  | { outcome: "enqueue_failed"; jobId: string }
  /** A repository or installation event updated `changed` records. */
  | { outcome: "applied"; changed: number }
  /** Billing refused the preview: the job ended `stopped_credits` and its check is `neutral` (spec 10.6). */
  | { outcome: "billing_refused"; jobId: string };

/**
 * The credit meter of a preview run (billing spec 10.5 and 10.6). The job
 * exists first, so a refused preview still gets its `neutral` check.
 */
export interface PreviewRunBilling {
  /** Null when the run may start (also with `BILLING_ENFORCEMENT=off` or `shadow`). */
  /**
   * `baselineVersionId` is the job's baseline: a preview without one is cold
   * and is metered as a full generation (`generation.run`).
   */
  admit(input: { jobId: string; projectId: string; baselineVersionId: string | null }): Promise<BillingRefusal | null>;
  /** Ends the refused job as `stopped_credits`; the billing page link for its check. */
  stop(input: { jobId: string; projectId: string; refusal: BillingRefusal }): Promise<string | null>;
}

export type DoxabotWebhookIngressResult =
  | { outcome: "claimed" }
  | { outcome: "duplicate" };

export interface ProcessGitHubWebhookInput {
  deliveryId: string;
  eventName: string;
  rawBody: string;
}

export interface DoxabotJobQueue {
  send(message: GenerateJobMessage, options?: { delaySeconds?: number }): Promise<unknown>;
}

/**
 * The quiet window of a pull request preview. The queue holds the message
 * this long before the worker starts the run. A newer push in that time
 * replaces the queued run before it starts, so quick pushes start one run.
 */
export const PREVIEW_QUIET_WINDOW_SECONDS = 120;

/** Cancels a preview job and closes its pull request check. */
export interface PreviewJobCanceller {
  /** False when the job had already ended. */
  cancel(input: GenerationCancellationInput): Promise<boolean>;
  /**
   * Closes the check and stops the container of a job that the admission of
   * a newer head already cancelled.
   */
  finishCancel(input: GenerationCancellationInput): Promise<void>;
}

/** How the run of an older head ends when a newer push replaces it. */
function supersededBy(headRevision: string): Omit<GenerationCancellationInput, "jobId"> {
  return {
    message: "Superseded by a newer pull request head.",
    eventType: "doxabot_superseded",
    data: { targetRevision: headRevision },
    check: SUPERSEDED_PREVIEW_CHECK,
  };
}

const PREVIEW_STOP_TEXT: Record<PreviewStopReason, string> = {
  closed: "The pull request was closed",
  merged: "The pull request was merged",
  retargeted: "The pull request no longer targets the production branch",
};

/** The pull request check text when a preview stops for `reason`. */
function stoppedPreviewCheck(reason: PreviewStopReason) {
  return {
    title: "Documentation preview stopped",
    summary: `${PREVIEW_STOP_TEXT[reason]}, so Doxa stopped this preview.`,
  };
}

/** Runs every step, also after one fails, then reports the first failure. */
async function runEach(steps: ReadonlyArray<() => Promise<unknown>>): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
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
  previewJobs: PreviewJobCanceller;
  previewChannels: PreviewChannelCloser;
  /** Absent: no credit metering, as with `BILLING_ENFORCEMENT=off`. */
  previewBilling?: PreviewRunBilling;
  /** Records of repository and installation events. */
  lifecycle: RepositoryLifecycleStore;
  /**
   * The default branch of a repository that an event names without one
   * (`installation_repositories.added`). Absent: such a repository gets no
   * row here, and the user's refresh of the repository list adds it.
   */
  repositoryDefaultBranch?: (input: {
    repositoryExternalId: string;
    installationExternalId: string;
  }) => Promise<string | null>;
  /** Defaults to {@link PREVIEW_QUIET_WINDOW_SECONDS}; 0 starts at once. */
  previewQuietSeconds?: number;
  /**
   * The largest repository that gets a preview, in KB (`MAX_REPOSITORY_SIZE_KB`).
   * Absent: no size check.
   */
  maxRepositorySizeKb?: number;
  /** Product analytics. Absent: nothing is reported. */
  analytics?: ProductAnalytics;
  /** Runs a preview again from its pull request check. Absent: such events are ignored. */
  previewRetries?: Pick<PreviewCheckRetryService, "retry">;
  now(): Date;
}

export class DoxabotWebhookOrchestrator {
  constructor(private readonly dependencies: DoxabotWebhookDependencies) {}

  /**
   * The caller builds the merge trigger and the preview retries, which need
   * its request context.
   */
  static fromEnv(
    env: Env,
    options: Pick<DoxabotWebhookDependencies, "mergeTriggers" | "previewRetries">,
  ): DoxabotWebhookOrchestrator {
    const jobs = new JobsRepository(env);
    const reviewRuns = ReviewRunsService.fromEnv(env);
    return new DoxabotWebhookOrchestrator({
      deliveries: new WebhookDeliveriesRepository(env),
      settings: new DoxabotSettingsRepository(env),
      changeProposals: new ChangeProposalsRepository(env),
      jobs,
      previewBaselines: new PreviewBaselinesRepository(env),
      queue: env.GENERATION_QUEUE,
      reviewRuns,
      changeProposalState:
        GitHubPullRequestStateResolver.fromEnv(env),
      deploymentPolicy: resolveDoxabotDeploymentPolicy(env),
      executionConfig: resolveDoxabotExecutionConfig(env),
      mergeTriggers: options.mergeTriggers,
      previewJobs: {
        cancel: async (input) =>
          (await cancelGenerationJob(env, jobs, input, reviewRuns)).transitioned,
        finishCancel: async (input) => {
          await finishGenerationCancellation(env, jobs, input, reviewRuns);
        },
      },
      previewChannels: new PreviewChannelClosureRepository(env),
      previewBilling: previewRunBillingFromEnv(env, jobs),
      lifecycle: new GitHubLifecycleRepository(env),
      repositoryDefaultBranch: (input) =>
        fetchRepositoryDefaultBranch(env, input.installationExternalId, input.repositoryExternalId),
      maxRepositorySizeKb: maxRepositorySizeKbFromEnv(env),
      analytics: productAnalyticsOf(env),
      previewRetries: options.previewRetries,
      now: () => new Date(),
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

    // Lifecycle events keep the records true also while Doxabot is off:
    // generations read the same rows.
    const lifecycleEvents = parsed.events.filter(
      (event) => event.kind === "repository_lifecycle" || event.kind === "installation_lifecycle",
    );
    if (lifecycleEvents.length === parsed.events.length) {
      return this.applyLifecycleEvents(identity, lifecycleEvents);
    }
    if (parsed.events.length !== 1) {
      return this.ignore(identity, "unexpected_event_batch");
    }

    const [event] = parsed.events;
    if (event.kind === "review_run_retry") {
      return this.retryPreview(identity, event);
    }
    if (event.kind !== "change_proposal" && event.kind !== "default_branch_push") {
      return this.ignore(identity, "unexpected_event_batch");
    }
    const context = await this.dependencies.settings.getAutomationContext({
      provider: event.repository.provider,
      repositoryExternalId: event.repository.externalId,
      installationExternalId: event.repository.installationExternalId,
    });
    if (!context) {
      return this.ignore(identity, "project_not_found");
    }

    // The app lost the repository, or the installation is suspended or
    // uninstalled: no automation, and no GitHub call that would fail. The
    // site stays live (Decision 4).
    if (context.connectionIssue) {
      return this.ignore(identity, context.connectionIssue);
    }

    const eligibility = evaluateDoxabotEligibility({
      deploymentPolicy: this.dependencies.deploymentPolicy,
      repository: {
        connected: true,
        visibility: event.repository.visibility,
      },
      hasPublishedVersion: context.hasPublishedVersion,
      storedEnabled: context.storedEnabled,
    });
    const ignoredReason = !eligibility.available
      ? eligibility.reason
      : eligibility.enabled
        ? null
        : "project_disabled";
    if (ignoredReason) {
      if (event.kind === "change_proposal") {
        await runEach([
          // The merge trigger has its own setting: a merge feeds it also
          // while previews are off. It needs Doxabot to be available.
          () =>
            eligibility.available
              ? this.recordProductionMerge(context, event)
              : Promise.resolve(),
          // Previews made before they were turned off still end with their
          // pull request.
          () => this.stopRecordedPreviews(context, event),
        ]);
      }
      return this.ignore(identity, ignoredReason);
    }

    if (event.kind === "default_branch_push") {
      return this.ignore(identity, "default_branch_push_deferred");
    }

    const skipped = skippedAuthorReason(event, context);
    if (skipped) {
      // No preview and no message on the pull request. A merge still feeds
      // the merge trigger: a maintainer merged it, so its code is in the
      // repository now. A preview made before this rule stops.
      await runEach([
        () => this.recordProductionMerge(context, event),
        () => this.stopSkippedPreviews(context, event),
      ]);
      return this.ignore(identity, skipped);
    }
    return this.processChangeProposal(identity, context, event);
  }

  /**
   * Applies repository and installation events to the records. Rows are
   * never deleted, so the site stays live; the connection issue they record
   * stops Doxabot and generations (Decision 4). The delivery is `processed`,
   * so the cleanup job keeps it as the record of the change.
   */
  private async applyLifecycleEvents(
    identity: WebhookDeliveryIdentity,
    events: ReadonlyArray<NormalizedRepositoryLifecycleEvent | NormalizedInstallationLifecycleEvent>,
  ): Promise<DoxabotWebhookResult> {
    let changed = 0;
    for (const event of events) {
      changed += event.kind === "installation_lifecycle"
        ? await this.applyInstallationEvent(event)
        : await this.applyRepositoryEvent(event);
    }
    await this.dependencies.deliveries.markProcessed(identity);
    return { outcome: "applied", changed };
  }

  private async applyInstallationEvent(
    event: NormalizedInstallationLifecycleEvent,
  ): Promise<number> {
    // The install callback records a new installation. Here Doxa keeps only
    // who installed it: the callback accepts an organization installation
    // only from that GitHub user (Decision 6).
    if (event.action === "created") {
      if (!event.sender) return 0;
      const recorded = await this.dependencies.lifecycle.recordInstaller({
        installationExternalId: event.installationExternalId,
        installer: { githubUserId: event.sender.externalId, login: event.sender.login },
      });
      return recorded ? 1 : 0;
    }
    const status = INSTALLATION_STATUS_FOR_ACTION[event.action];
    if (!status) return 0;
    return this.dependencies.lifecycle.setInstallationStatus({
      installationExternalId: event.installationExternalId,
      status,
      at: this.dependencies.now(),
    });
  }

  private async applyRepositoryEvent(
    event: NormalizedRepositoryLifecycleEvent,
  ): Promise<number> {
    const { lifecycle } = this.dependencies;
    const { repository } = event;
    const at = this.dependencies.now();
    switch (event.change) {
      case "removed":
      case "deleted": {
        const disconnected = await lifecycle.disconnectRepository({
          repositoryExternalId: repository.externalId,
          installationExternalId: repository.installationExternalId,
          reason: event.change,
          at,
        });
        if (disconnected) {
          console.warn("Doxabot stopped for a repository that GitHub took away.", {
            repositoryExternalId: repository.externalId,
            reason: event.change,
          });
        }
        return disconnected ? 1 : 0;
      }
      case "added":
      case "created":
        return (await this.addRepository(event)) ? 1 : 0;
      case undefined:
        // A delivery normalized before `change` existed: nothing is certain.
        return 0;
      default: {
        const updated = await lifecycle.updateRepository({
          repositoryExternalId: repository.externalId,
          visibility: repository.visibility,
          ...(repository.fullName ? { fullName: repository.fullName } : {}),
          ...(repository.owner ? { owner: repository.owner } : {}),
          ...(repository.name ? { name: repository.name } : {}),
          ...(repository.defaultBranch ? { defaultBranch: repository.defaultBranch } : {}),
        });
        if (!updated) return 0;
        // A public repository that became private keeps its public site, but
        // Doxabot stops updating it until the owner decides (Decision 4).
        if (updated.previousVisibility === "public" && repository.visibility === "private") {
          await lifecycle.pauseAutomation({
            projectIds: updated.projectIds,
            reason: "repository_privatized",
            at,
          });
          if (updated.projectIds.length > 0) {
            console.warn("Doxabot paused for a repository that became private.", {
              repositoryExternalId: repository.externalId,
              projectIds: updated.projectIds,
            });
          }
        }
        return 1;
      }
    }
  }

  /**
   * A repository that the installation got: a new or forked repository of an
   * installation on all repositories (`repository.created`), or one added to
   * the selection (`installation_repositories.added`). A row that GitHub took
   * away before is connected again. Else a new row needs the names and the
   * default branch. An event without the branch costs one read of the
   * repository, only when Doxa knows the installation and has no row yet.
   * True when a row changed.
   */
  private async addRepository(event: NormalizedRepositoryLifecycleEvent): Promise<boolean> {
    const { lifecycle } = this.dependencies;
    const { repository } = event;
    const identity = {
      repositoryExternalId: repository.externalId,
      installationExternalId: repository.installationExternalId,
    };
    if (await lifecycle.reconnectRepository({ ...identity, visibility: repository.visibility })) {
      return true;
    }
    const names = repositoryNames(repository);
    if (!names) return false;
    if (!(await lifecycle.canAddRepository(identity))) return false;
    const defaultBranch = repository.defaultBranch ?? (await this.readDefaultBranch(identity));
    // The user's refresh of the repository list adds it later.
    if (!defaultBranch) return false;
    return lifecycle.addRepository({
      ...identity,
      ...names,
      defaultBranch,
      visibility: repository.visibility,
    });
  }

  private async readDefaultBranch(identity: {
    repositoryExternalId: string;
    installationExternalId: string;
  }): Promise<string | null> {
    const read = this.dependencies.repositoryDefaultBranch;
    if (!read) return null;
    try {
      return await read(identity);
    } catch (caught) {
      console.warn("GitHub did not give the default branch of a new repository.", {
        repositoryExternalId: identity.repositoryExternalId,
        error: caught instanceof Error ? caught.message : String(caught),
      });
      return null;
    }
  }

  /**
   * The cleanup of a pull request that Doxabot skips (a fork, or a bot that
   * is not allowed): a preview recorded before the rule stops and its site
   * goes offline. A pull request that Doxa never recorded has none.
   */
  private async stopSkippedPreviews(
    context: DoxabotAutomationContext,
    event: NormalizedChangeProposalEvent,
  ): Promise<void> {
    const recorded = await this.dependencies.changeProposals.getByIdentity({
      projectId: context.projectId,
      provider: event.repository.provider,
      externalId: event.change.externalId,
    });
    if (!recorded) return;
    const state = lifecycleStateFor(event);
    if (state !== "open") {
      await this.stopPreviews(context, event, state);
      return;
    }
    await runEach([
      () =>
        this.cancelActivePreview(context, event, {
          message: SKIPPED_PREVIEW_TEXT,
          eventType: "doxabot_change_skipped",
          data: { reason: event.change.fromFork ? "fork_pull_request" : "bot_author" },
          check: { title: "Documentation preview stopped", summary: SKIPPED_PREVIEW_TEXT },
        }),
      () =>
        this.dependencies.previewChannels.closeForChange({
          projectId: context.projectId,
          provider: event.repository.provider,
          changeExternalId: event.change.externalId,
          closedAt: this.dependencies.now(),
        }),
    ]);
  }

  private async processChangeProposal(
    identity: WebhookDeliveryIdentity,
    context: DoxabotAutomationContext,
    event: NormalizedChangeProposalEvent,
  ): Promise<DoxabotWebhookResult> {
    // Previews and the merge trigger follow the project's production
    // branch, which can differ from the repository's default branch.
    if (event.change.baseRef !== context.productionBranch) {
      // A pull request that moved off the production branch, or a preview
      // made before the production branch changed, stops here.
      await this.stopRecordedPreviews(context, event);
      return this.ignore(identity, "non_production_base");
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
      defaultBranch: context.productionBranch,
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

    if (lifecycleState !== "open") {
      // A merge into the production branch feeds the merge trigger, which may
      // start a production run that goes to a review. The merge and the
      // preview cleanup do not depend on each other, so each runs even when
      // the other fails.
      await runEach([
        () => this.recordProductionMerge(context, event),
        () => this.stopPreviews(context, event, lifecycleState),
      ]);
      return this.ignore(
        identity,
        lifecycleState === "merged" ? "change_merged" : "change_closed",
      );
    }
    if (event.change.draft || event.action === "converted_to_draft") {
      return this.ignore(identity, "draft_change");
    }

    // The same limit as production runs, checked before admission, so no job,
    // clone or model call starts. GitHub's check needs a job, so a new head
    // gets no check. A preview still running on an older head stops with a
    // neutral check; the last finished preview stays online.
    const tooLarge = this.dependencies.maxRepositorySizeKb === undefined
      ? null
      : checkRepositorySize(event.change.repositorySizeKb, this.dependencies.maxRepositorySizeKb);
    if (tooLarge) {
      await this.cancelActivePreview(context, event, {
        message: tooLarge.message,
        eventType: "doxabot_preview_refused",
        data: { reason: "repository_too_large", sizeKb: tooLarge.sizeKb, limitKb: tooLarge.limitKb },
        check: { title: "Documentation preview stopped", summary: `${tooLarge.message} Doxa stopped this preview.` },
      });
      return this.ignore(identity, "repository_too_large");
    }

    return this.enqueuePreview(identity, context, event, proposal);
  }

  /**
   * Feeds a pull request that merged into the production branch to the
   * merge trigger. The trigger setting decides if a production run starts.
   * A merge is final, so this needs no record and no staleness check, and
   * the pending merge of a pull request is recorded once.
   */
  private async recordProductionMerge(
    context: DoxabotAutomationContext,
    event: NormalizedChangeProposalEvent,
  ): Promise<void> {
    if (lifecycleStateFor(event) !== "merged") return;
    if (event.change.baseRef !== context.productionBranch) return;
    await this.dependencies.mergeTriggers.recordMerge({
      projectId: context.projectId,
      mergeTrigger: context.mergeTrigger,
      changeExternalId: event.change.externalId,
      changeNumber: event.change.number,
      mergedAt: new Date(event.change.sourceUpdatedAt),
    });
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
          defaultBranch: context.productionBranch,
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
    const supersede = supersededBy(event.change.headRevision.commitSha);
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
      baselineRevision: previewBaseline
        ? previewBaseline.sourceRevision
        : context.publishedBaseline?.sourceRevision ?? null,
      targetRevision: event.change.headRevision.commitSha,
      sourceTreeHash: null,
      baselineVersionId:
        previewBaseline?.versionId ??
        context.publishedBaseline?.versionId ??
        null,
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
      // The record as this delivery wrote it. A close, a base change or a
      // newer push that lands before the admission refuses this preview.
      guard: { seen: proposal, productionBranch: context.productionBranch },
      supersede,
    };
    const admission =
      await this.dependencies.jobs.admitDoxabotJob(admissionInput);
    if (admission.outcome === "stale_change") {
      return this.ignore(identity, "stale_change_event");
    }
    if (admission.outcome === "concurrency_conflict") {
      throw new Error("Preview admission remained conflicted.");
    }
    if (admission.supersededJobId) {
      await this.dependencies.previewJobs.finishCancel({
        ...supersede,
        jobId: admission.supersededJobId,
      });
    }

    // Billing spec 10.5 step 1. A replayed delivery found its job, and that
    // job's own admission already holds its credits.
    if (admission.outcome === "created" && this.dependencies.previewBilling) {
      const billing = this.dependencies.previewBilling;
      const refusal = await billing.admit({
        jobId: admission.job.id,
        projectId: context.projectId,
        // The created job has the baseline of this admission input.
        baselineVersionId: admissionInput.baselineVersionId,
      });
      if (refusal) {
        const detailsUrl = await billing.stop({ jobId: admission.job.id, projectId: context.projectId, refusal });
        await this.reportBillingStop(admission.job.id, event, refusal, detailsUrl);
        await this.dependencies.deliveries.markProcessed(identity);
        return { outcome: "billing_refused", jobId: admission.job.id };
      }
    }
    if (admission.outcome === "created" && this.dependencies.analytics) {
      captureGenerationStarted(this.dependencies.analytics, {
        ownerUserId: context.ownerUserId,
        projectId: context.projectId,
        trigger: "doxabot",
        baselineVersionId: admissionInput.baselineVersionId,
      });
    }

    const externalReviewRunId = await this.reconcileReviewRun(
      admission.job,
      event,
    );

    if (!admission.queuePublished) {
      try {
        const quietSeconds =
          this.dependencies.previewQuietSeconds ?? PREVIEW_QUIET_WINDOW_SECONDS;
        await this.dependencies.queue.send(
          {
            jobId: admission.job.id,
            projectId: context.projectId,
            userId: context.ownerUserId,
          },
          quietSeconds > 0 ? { delaySeconds: quietSeconds } : undefined,
        );
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

  /**
   * Billing spec 10.6: a preview that cannot reserve credits finishes its
   * check `neutral` with a billing link, so it never fails the customer's CI.
   */
  private async reportBillingStop(
    jobId: string,
    event: NormalizedChangeProposalEvent,
    refusal: BillingRefusal,
    detailsUrl: string | null,
  ): Promise<void> {
    try {
      await this.dependencies.reviewRuns.create(jobId, {
        ...mapDoxabotReviewRunState("neutral"),
        ...billingStopCheck(refusal),
        detailsUrl,
        sourceRevision: event.change.headRevision.commitSha,
      });
    } catch (error) {
      await this.dependencies.jobs.addEvent(
        jobId,
        "review_run_create_failed",
        "Doxabot could not create the external review run.",
        { error: errorMessage(error) },
        "system",
      );
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

  /**
   * The cleanup of a pull request event that gets no preview: Doxabot is off
   * or unavailable, or the base is not the production branch. Only a pull
   * request that Doxa recorded can have a preview. Its record takes the event
   * through the same staleness checks as the main path, so a late "closed"
   * event never stops the preview of a reopened pull request.
   */
  private async stopRecordedPreviews(
    context: DoxabotAutomationContext,
    event: NormalizedChangeProposalEvent,
  ): Promise<void> {
    const recorded = await this.dependencies.changeProposals.getByIdentity({
      projectId: context.projectId,
      provider: event.repository.provider,
      externalId: event.change.externalId,
    });
    if (!recorded) return;

    const applied = await this.applyChangeProposalEvent(
      { outcome: "existing", proposal: recorded },
      context,
      event,
    );
    if (typeof applied === "string") return;

    const state = lifecycleStateFor(event);
    if (state !== "open") {
      await this.stopPreviews(context, event, state);
    } else if (event.change.baseRef !== context.productionBranch) {
      await this.stopPreviews(context, event, "retargeted");
    } else if (applied.headRevision !== recorded.headRevision) {
      // Doxabot is off, so no newer preview replaces a run on the old head.
      // It stops as superseded; the last finished preview stays online.
      await this.cancelActivePreview(
        context,
        event,
        supersededBy(event.change.headRevision.commitSha),
      );
    }
  }

  /**
   * A pull request that ends, or leaves the production branch, cancels its
   * queued or running preview, so no credits go to a preview that no one can
   * use, and takes its preview site offline. The retention policy then
   * collects the last preview version. The cancel goes first: a preview that
   * completes after it cannot take the channel back.
   */
  private async stopPreviews(
    context: DoxabotAutomationContext,
    event: NormalizedChangeProposalEvent,
    reason: PreviewStopReason,
  ): Promise<void> {
    await runEach([
      () =>
        this.cancelActivePreview(context, event, {
          message: `${PREVIEW_STOP_TEXT[reason]}.`,
          eventType: "doxabot_change_ended",
          data: { reason },
          check: stoppedPreviewCheck(reason),
        }),
      () =>
        this.dependencies.previewChannels.closeForChange({
          projectId: context.projectId,
          provider: event.repository.provider,
          changeExternalId: event.change.externalId,
          closedAt: this.dependencies.now(),
        }),
    ]);
  }

  /** Cancels the queued or running preview of the pull request, if any. */
  private async cancelActivePreview(
    context: DoxabotAutomationContext,
    event: NormalizedChangeProposalEvent,
    cancellation: Omit<GenerationCancellationInput, "jobId">,
  ): Promise<void> {
    const active = await this.dependencies.jobs.activeForConcurrencyKey(
      previewConcurrencyKey({
        projectId: context.projectId,
        provider: event.repository.provider,
        changeExternalId: event.change.externalId,
      }),
    );
    if (active) {
      await this.dependencies.previewJobs.cancel({ ...cancellation, jobId: active.id });
    }
  }

  /**
   * "Re-run" or "Retry preview" on a preview check. The retry service checks
   * the person and the check; Doxabot's own setting does not stop it, as with
   * the dashboard's re-run.
   */
  private async retryPreview(
    identity: WebhookDeliveryIdentity,
    event: NormalizedReviewRunRetryEvent,
  ): Promise<DoxabotWebhookResult> {
    const retries = this.dependencies.previewRetries;
    if (!retries) return this.ignore(identity, "preview_retry_unavailable");

    const result = await retries.retry(event);
    if (result.outcome === "refused") {
      return this.ignore(identity, `preview_retry_${result.reason}`);
    }
    await this.dependencies.deliveries.markProcessed(identity);
    return { outcome: "enqueued", jobId: result.jobId };
  }

  private async ignore(
    identity: WebhookDeliveryIdentity,
    reason: string,
  ): Promise<DoxabotWebhookResult> {
    await this.dependencies.deliveries.markIgnored({ ...identity, reason });
    return { outcome: "ignored", reason };
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

const SKIPPED_PREVIEW_TEXT =
  "Doxabot does not preview pull requests from forks or from bots that the project does not allow.";

/** The installation status that an `installation` action sets; null: no change. */
const INSTALLATION_STATUS_FOR_ACTION: Record<
  NormalizedInstallationLifecycleEvent["action"],
  GitHubInstallationStatus | null
> = {
  created: null,
  permissions_accepted: null,
  deleted: "deleted",
  suspended: "suspended",
  unsuspended: "active",
};

/**
 * Why Doxabot skips the preview of a pull request, or null. Every pull
 * request from a fork is skipped, whoever opened it (Decision 3): a fork is
 * a separate repository. A bot is skipped unless the project allows it by
 * login.
 */
export function skippedAuthorReason(
  event: NormalizedChangeProposalEvent,
  context: Pick<DoxabotAutomationContext, "allowedBotLogins">,
): "fork_pull_request" | "bot_author" | null {
  if (event.change.fromFork) return "fork_pull_request";
  if (!event.change.authorIsBot) return null;
  const login = event.change.author?.handle;
  const allowed = login !== undefined && context.allowedBotLogins.some(
    (entry) => normalizeBotLogin(entry) === normalizeBotLogin(login),
  );
  return allowed ? null : "bot_author";
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
  const firstEvent = parsed.outcome === "normalized" ? parsed.events[0] : undefined;
  const normalizedRepository =
    firstEvent && firstEvent.kind !== "installation_lifecycle" ? firstEvent.repository : undefined;
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

/**
 * The names of a new repository row. An `installation_repositories` event
 * gives no owner, so it comes from the full name. Null without a full name
 * of the form `owner/name`.
 */
function repositoryNames(
  repository: NormalizedRepositoryLifecycleEvent["repository"],
): { fullName: string; owner: string; name: string } | null {
  const { fullName } = repository;
  if (!fullName) return null;
  const parts = fullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return {
    fullName,
    owner: repository.owner ?? parts[0],
    name: repository.name ?? parts[1],
  };
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

/** The check text of a preview that billing refused (billing spec 10.6). */
export function billingStopCheck(refusal: BillingRefusal): { title: string; summary: string } {
  if (refusal instanceof CreditsExhaustedError) return { ...STOPPED_CREDITS_CHECK };
  if (refusal instanceof PlanLimitError && refusal.details.key === "ai.doxa_agent") {
    return {
      title: "Full generation is not in the plan",
      summary:
        "This pull request has no generation cache yet, so its preview is a full generation, and the account's plan does not include full generations. Upgrade the plan on the billing page to get this preview.",
    };
  }
  if (refusal instanceof PlanLimitError) {
    return {
      title: "Doxabot is not in the plan",
      summary: "The account's plan does not include Doxabot previews. Upgrade the plan on the billing page to get previews.",
    };
  }
  return {
    title: "Documentation preview paused",
    summary: "Doxa paused AI runs for this account, so it did not generate a preview. The billing page has the details.",
  };
}

/** The preview billing port over the credit meter and the jobs table. */
export function previewRunBillingFromEnv(env: Env, jobs: JobsRepository): PreviewRunBilling | undefined {
  const metering = generationMeteringFromEnv(env);
  if (metering.mode === "off") return undefined;
  const config = resolveDoxabotExecutionConfig(env);
  return {
    async admit({ jobId, projectId, baselineVersionId }) {
      const job = { publicationMode: "preview", trigger: "doxabot", baselineVersionId } as const;
      const verdict = await metering.admit({
        jobId,
        projectId,
        action: meteredActionOf(job),
        features: requiredFeaturesOf(job),
        models: runModels(env, config),
      });
      return verdict.kind === "refused" ? verdict.error : null;
    },
    async stop({ jobId, projectId, refusal }) {
      await jobs.markStoppedCredits(jobId, {
        reason: refusal instanceof CreditsExhaustedError ? "credits_exhausted" : refusal.code,
        message: billingStopCheck(refusal).summary,
        finishedPageCount: 0,
      });
      return billingPageUrlForProject(env, projectId);
    },
  };
}
