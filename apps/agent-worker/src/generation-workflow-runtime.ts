import {
  DEFAULT_DOXA_PLANNER_MODEL,
  DEFAULT_DOXA_WRITER_MODEL,
  GENERATION_STATE_SCHEMA_VERSION,
  MAX_WRITE_GROUP_PAGES,
  NO_PROJECT_INSTRUCTIONS_FINGERPRINT,
  WORKFLOW_STEP_FAILED_EVENT_TYPE,
  PUBLIC_DOCUMENTATION_POLICY_VERSION,
  WRITING_CONTRACT_VERSION,
  containerGenerationStageResultSchema,
  generationPageStateSchema,
  runtimeDocsNavigationSchema,
  runtimeDocsFeaturesSchema,
  stagedRuntimePageSchema,
  writerHandoffManifestSchema,
  type ContainerGenerateRequest,
  type ContainerArtifactFile,
  type ContainerGenerationStageRequest,
  type ContainerGenerationStageResult,
  type DoxabotReviewRunState,
  type GenerateJobMessage,
  type GenerationContext,
  type GenerationDatabaseCompatibility,
  type GenerationExecutionContext,
  type GenerationPageState,
  type IncrementalGenerationPlan,
  type PreviousPageText,
  type ReusableGenerationState,
  type RuntimeDocsNavigation,
  type SourceChange,
  type SourceProvider,
  type StagedRuntimePage,
  type WriterHandoffManifest,
} from "@doxahq/contracts";
import { GENERATION_CHECKPOINT_PREFIX } from "@doxahq/contracts/storage-lifecycle";
import type { PageNotice } from "@doxahq/contracts/generation-reviews";
import {
  createR2GenerationPageCheckpointStore,
  parseGenerationPageCheckpoint,
  runResumablePageBatch,
} from "./generation-page-checkpoints";
import {
  buildPageCacheDescriptor,
  createR2GenerationPageCache,
  pageDependencyPaths,
  preparePageBatchCacheContexts,
  runPageBatchWithCache,
  structureSourceEvidenceByPageId,
  type PageBatchCacheContext,
  type PageBatchCacheResult,
} from "./generation-page-cache";
import {
  assessGenerationFeasibility,
  requestAgentContainerDestroy,
  sanitizeErrorMessage,
  validateArtifactLinks,
  validateArtifactFiles,
  type WritingStageBudgetInput,
} from "@doxahq/generation";
import {
  buildArtifactPrefix,
  generationStateOwnerVersionId,
  createRuntimeDocsArtifacts,
  sourcePathForHref,
} from "@doxahq/docs-engine";
import { z } from "zod";
import { artifactReader, writeArtifactVersion } from "./artifact-storage";
import { GenerationNonRetryableError } from "./generation-errors";
import {
  generationModelIds,
  modelApiKeySecrets,
  resolveGenerationModels,
  resolveStageModelAuth,
} from "./model-provider";
import {
  pageBriefFingerprints,
  pageInstructionsFingerprints,
  pageSourcesOf,
} from "./review-evidence";
import { syncReusableStateWithLive } from "./live-state-sync";
import {
  executionContextFailureMessage,
  GENERATION_CONTEXT_UNAVAILABLE_EVENT_TYPE,
  isPermanentContextFailure,
} from "./execution-context-failure";
import { checkPageFailureBudgetStep, NO_STEP_RETRIES, runBestEffortStep, settleWritePhase } from "./best-effort-step";
import {
  pageNoticePayloadKey,
  readPageNoticePayload,
  storePageNoticePayload,
  writePhaseOutcomeOf,
  type PageNoticePayload,
  type RecordedWritePhaseOutcome,
  type WritePhaseOutcome,
} from "./write-phase-outcome";
import {
  behindInstructionPageIds,
  failuresUnderBudget,
  publishedBehindPageIds,
  readInstructionCatchUpLedger,
  recordInstructionCatchUp,
} from "./instruction-catch-up";
import { findSiteNavigation, loadSeedSite, loadSiteNavigation } from "./seed-site";
import { readPreviousPages } from "./previous-pages";
import { withStepCallDeadline } from "./step-call-deadline";
import {
  DEFAULT_TEMPLATE_PAGE_BATCH_TIMEOUT_MS,
  planWriteGroups,
  templatePageIdsOf,
  writeGroupNoun,
  writingBudgetOf,
  type WriteGroupTimeouts,
} from "./write-groups";
import { trackWorkflowSteps } from "./workflow-step-tracker";
import {
  MAX_WRITER_SLOT_TTL_MS,
  resolveWriterSlotLimiter,
  type WriterSlotLimiter,
} from "./writer-slots";
import {
  createR2GenerationPlanCache,
  isCachedPlanResult,
  planCacheKey,
} from "./generation-plan-cache";
import {
  assertPageFailureBudget,
  collectPageBatchOutcomes,
  isPageFailureBudgetExceeded,
  isRunStoppingError,
  pageTitlesFromStructure,
  planWithFailedPages,
  recordFlaggedPages,
  type PageBatchOutcome,
  type SettledBatch,
} from "./generation-page-failures";
import {
  behindInstructionCandidates,
  behindInstructionsNotices,
  openIssueNotices,
  recordPageNotices,
} from "./page-notices";
import {
  applyPageLocks,
  changedSourcePaths,
  lockedHrefsOf,
  lockedPageFlagsOf,
} from "./page-locks";
import type { Env } from "./index";
import {
  assembleCheckpointedPages,
  assembleIncrementalPages,
  createProductionCompletionInput,
  isAcceptedPullRequestRevision,
  isProductionTrigger,
  isRevisionAwareProductionContext,
  materializeReusablePage,
  resolveGenerationCheckoutSpec,
  resolveGenerationExecutionConfig,
  modelForGenerationStage,
} from "./generation-workflow";
import {
  callGenerationStage,
  GenerationStageRequestError,
} from "./workflow-stage-client";
import {
  GenerationStateStore,
  createR2GenerationStateStorage,
  generationStatePrefix,
  sha256Hex,
} from "./generation-state-store";
import {
  forwardGenerationStageEvent,
  forwardGenerationStageFailure,
} from "./stage-event-forwarder";
import {
  logGenerationUsageSummary,
  logPersistedGenerationUsageSummary,
  persistGenerationDiagnostic,
  persistGenerationUsage,
  summarizeGenerationUsageRecords,
} from "./generation-observability";

interface PreparedGeneration {
  context: GenerationContext;
  versionId: string;
}

interface StructureCheckpoint {
  structureCheckpoint: string;
  pageIds: string[];
  navigation: RuntimeDocsNavigation;
  runtimeFeatures?: { apiPlayground: boolean };
  writerHandoff?: WriterHandoffManifest;
}

type SuccessfulAnalysisStageResult = Extract<
  ContainerGenerationStageResult,
  { stage: "analysis"; checkpoint: string }
> & {
  snapshot: NonNullable<
    Extract<
      ContainerGenerationStageResult,
      { stage: "analysis"; checkpoint: string }
    >["snapshot"]
  >;
  sourceState: NonNullable<
    Extract<
      ContainerGenerationStageResult,
      { stage: "analysis"; checkpoint: string }
    >["sourceState"]
  >;
  analysisState: NonNullable<
    Extract<
      ContainerGenerationStageResult,
      { stage: "analysis"; checkpoint: string }
    >["analysisState"]
  >;
  preliminaryPlan: NonNullable<
    Extract<
      ContainerGenerationStageResult,
      { stage: "analysis"; checkpoint: string }
    >["preliminaryPlan"]
  >;
  structuralFingerprint: NonNullable<
    Extract<
      ContainerGenerationStageResult,
      { stage: "analysis"; checkpoint: string }
    >["structuralFingerprint"]
  >;
};

type IncrementalStructureStageResult = Extract<
  ContainerGenerationStageResult,
  { stage: "structure" }
> & {
  plan: IncrementalGenerationPlan;
  structureState: NonNullable<
    Extract<
      ContainerGenerationStageResult,
      { stage: "structure" }
    >["structureState"]
  >;
};

const finalizationCheckpointSchema = z.object({
  pageStates: z.array(generationPageStateSchema),
  artifactPrefix: z.string().min(1),
  manifestPath: z.string().min(1),
  sourceRevision: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  sourceTreeHash: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  changedSourceCount: z.number().int().nonnegative(),
  regeneratedPageCount: z.number().int().nonnegative(),
  reusedPageCount: z.number().int().nonnegative(),
  /** Pages that failed; each kept its published version or was left out. */
  flaggedPageCount: z.number().int().nonnegative().default(0),
}).strict();

type GenerationFinalizationCheckpoint = z.infer<
  typeof finalizationCheckpointSchema
>;

type SuccessfulPlanStageResult = Extract<
  ContainerGenerationStageResult,
  { stage: "plan"; analysisCheckpoint: string }
>;

type IncrementalPlanStageResult = SuccessfulPlanStageResult & {
  snapshot: NonNullable<SuccessfulPlanStageResult["snapshot"]>;
  sourceState: NonNullable<SuccessfulPlanStageResult["sourceState"]>;
  analysisState: NonNullable<SuccessfulPlanStageResult["analysisState"]>;
  structureState: NonNullable<SuccessfulPlanStageResult["structureState"]>;
  preliminaryPlan: NonNullable<
    SuccessfulPlanStageResult["preliminaryPlan"]
  >;
  plan: NonNullable<SuccessfulPlanStageResult["plan"]>;
  structuralFingerprint: NonNullable<
    SuccessfulPlanStageResult["structuralFingerprint"]
  >;
};

const DEFAULT_ANALYSIS_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_STRUCTURE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_PAGE_BATCH_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_FINALIZATION_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 3 * 60 * 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

export function isPlanStageEnabled(configured: string | undefined): boolean {
  return configured?.trim() !== "0";
}

export interface GenerationWorkflowEvent<T> {
  payload: T;
  timestamp: Date;
}

export interface GenerationWorkflowStep {
  do<T>(
    name: string,
    config: unknown,
    callback: () => Promise<T>,
  ): Promise<T>;
}

interface WorkflowBatchDispatchInput<TBatch, TResult> {
  batches: readonly TBatch[];
  parallelism: number;
  step: GenerationWorkflowStep;
  stepName: (index: number, total: number, batch: TBatch) => string;
  stepConfig: (index: number, batch: TBatch) => unknown;
  runBatch: (batch: TBatch, index: number) => Promise<TResult>;
  /**
   * True for an error that ends the whole run, such as a cancelled job.
   * Any other batch failure stays with its batch, and the rest still run.
   */
  isRunStopping: (error: unknown) => boolean;
}

/**
 * Runs every batch as its own Workflow step, `parallelism` at a time. A batch
 * that fails after its step retries settles as rejected; the caller decides
 * what its pages mean for the run. A run-stopping error starts no new batch
 * and is thrown once the running batches end.
 */
export async function dispatchWorkflowBatches<TBatch, TResult>(
  input: WorkflowBatchDispatchInput<TBatch, TResult>,
): Promise<SettledBatch<TResult>[]> {
  if (!Number.isInteger(input.parallelism) || input.parallelism < 1) {
    throw new Error("Workflow batch parallelism must be a positive integer.");
  }

  const entries = Array.from(input.batches.entries());
  const results: Array<SettledBatch<TResult> | undefined> = Array.from(
    { length: entries.length },
    () => undefined,
  );
  let cursor = 0;
  let stopping: { error: unknown } | undefined;

  const runWorker = async (): Promise<void> => {
    while (!stopping) {
      const entry = entries[cursor];
      if (!entry) return;
      cursor += 1;
      const [index, batch] = entry;

      try {
        const value = await input.step.do(
          input.stepName(index, entries.length, batch),
          input.stepConfig(index, batch),
          () => input.runBatch(batch, index),
        );
        results[index] = { status: "fulfilled", value };
      } catch (error) {
        if (input.isRunStopping(error)) {
          stopping ??= { error };
          return;
        }
        results[index] = { status: "rejected", reason: error };
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(input.parallelism, entries.length) },
      () => runWorker(),
    ),
  );

  if (stopping) throw stopping.error;

  return results.map((result, index) =>
    result ?? {
      status: "rejected",
      reason: new Error(`Workflow batch ${index + 1} did not run.`),
    }
  );
}

export function adaptGenerationWorkflowStep(
  step: GenerationWorkflowStep,
  createNonRetryableError: (
    error: GenerationNonRetryableError,
  ) => Error,
): GenerationWorkflowStep {
  return {
    do(name, config, callback) {
      return step.do(name, config, async () => {
        try {
          return await callback();
        } catch (error) {
          if (error instanceof GenerationNonRetryableError) {
            throw createNonRetryableError(error);
          }
          throw error;
        }
      });
    },
  };
}

export { GenerationNonRetryableError };

const NonRetryableError = GenerationNonRetryableError;

export class GenerationWorkflowRunner {
  constructor(readonly env: Env) {}

  async run(
    event: Readonly<GenerationWorkflowEvent<GenerateJobMessage>>,
    step: GenerationWorkflowStep,
  ): Promise<
    | { versionId: string }
    | {
        outcome: "superseded" | "action_required";
        versionId: null;
      }
  > {
    const input = event.payload;
    // Deleted after a success. The R2 lifecycle rule of the prefix expires
    // the checkpoints of a failed or cancelled run.
    const checkpointPrefix = `${GENERATION_CHECKPOINT_PREFIX}${input.jobId}`;
    const overallTimeoutMs = positiveNumber(this.env.GENERATION_OVERALL_TIMEOUT_MS, DEFAULT_OVERALL_TIMEOUT_MS);
    const writeBatchParallelism = resolveWriteBatchParallelism(
      this.env.DOXA_WRITE_BATCH_PARALLELISM,
    );
    const databaseCompatibility = await step.do(
      "verify generation database schema",
      boundedStepConfig(event.timestamp, overallTimeoutMs, 2 * 60_000),
      () => this.env.API.getGenerationDatabaseCompatibility(),
    );
    try {
      assertGenerationDatabaseCompatible(databaseCompatibility);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Generation database schema is incompatible.";
      await this.env.API.markJobFailed(input.jobId, message).catch(() => undefined);
      await this.env.API.addJobEvent(input.jobId, {
        type: "database_schema_incompatible",
        message,
        source: "worker",
        data: {
          missingColumns: databaseCompatibility.missingColumns,
        },
      }).catch(() => undefined);
      throw error;
    }
    let executionContext: Awaited<ReturnType<Env["API"]["getGenerationExecutionContext"]>>;
    try {
      executionContext = await step.do(
        "resolve generation execution mode",
        boundedStepConfig(event.timestamp, overallTimeoutMs, 2 * 60_000),
        async () => {
          try {
            return await this.env.API.getGenerationExecutionContext(input.jobId);
          } catch (error) {
            // A refusal stays a refusal, so the step stops without retries.
            if (isPermanentContextFailure(error)) {
              throw new NonRetryableError(executionContextFailureMessage(error));
            }
            throw error;
          }
        },
      );
    } catch (error) {
      // The step failed after its retries. Without this the job would stay
      // queued with no message.
      const message = executionContextFailureMessage(error);
      await this.env.API.markJobFailed(input.jobId, message).catch(() => undefined);
      await this.env.API.addJobEvent(input.jobId, {
        type: GENERATION_CONTEXT_UNAVAILABLE_EVENT_TYPE,
        message,
        source: "worker",
      }).catch(() => undefined);
      throw error;
    }
    const projectInstructions = executionContext?.doxabotInstructions;
    if (projectInstructions) {
      // Its own step, so a retry or "Continue run" records the event once.
      await step.do(
        "record project instructions",
        boundedStepConfig(event.timestamp, overallTimeoutMs, 60_000),
        () => recordProjectInstructions(this.env, input.jobId, projectInstructions.version),
      );
    }
    if (
      executionContext?.job.publicationMode === "preview" ||
      isRevisionAwareProductionContext(executionContext)
    ) {
      try {
        const result = await this.runRevisionAwareGeneration(
          await withResumedBudgetStart(this.env, event),
          step,
          executionContext,
          checkpointPrefix,
          overallTimeoutMs,
          writeBatchParallelism,
        );
        await logUsageSummarySafely(
          this.env,
          input.jobId,
          result.versionId !== null ? "completed" : result.outcome,
        );
        return result;
      } catch (error) {
        await logUsageSummarySafely(
          this.env,
          input.jobId,
          usageFailureStatus(error),
        );
        throw error;
      }
    }

    try {
      const prepared = await step.do(
        "prepare generation",
        boundedStepConfig(event.timestamp, overallTimeoutMs, 5 * 60_000),
        async () => {
          ensureWithinOverallBudget(event.timestamp, overallTimeoutMs);
          const control = await this.env.API.getGenerationControl();
          if (control.status === "paused") {
            const message = control.reason
              ? `Generation is paused: ${control.reason}`
              : "Generation is paused.";
            await this.env.API.markJobCancelled(input.jobId, message);
            throw new NonRetryableError(message);
          }
          // Fails before the job runs when no token and no key is available.
          await resolveStageModelAuth(this.env, this.env.API, []);
          await this.env.API.markJobRunning(input.jobId);
          const context = await this.env.API.getGenerationContext(input.projectId);
          if (!context) throw new NonRetryableError("Generation context not found for project.");
          await this.env.API.addJobEvent(input.jobId, {
            type: "workflow_started",
            message: "Durable documentation generation workflow started.",
            source: "worker",
            data: {
              repositoryFullName: context.repository.fullName,
              generationProfile: this.env.DOXA_GENERATION_PROFILE ?? "fast-mvp",
              overallTimeoutMs,
              writeBatchParallelism,
            },
          });
          return { context, versionId: crypto.randomUUID() };
        },
      );

      let analysis: { key: string };
      // `templatePageIds` is absent in step results recorded before template groups.
      let structure: { key: string; pageIds: string[]; templatePageIds?: string[] };
      if (isPlanStageEnabled(this.env.DOXA_PLAN_STAGE_ENABLED)) {
        const planned = await step.do(
          "plan documentation",
          boundedStepConfig(
            event.timestamp,
            overallTimeoutMs,
            combinedPlanningTimeoutMs(this.env),
          ),
          async () => {
            ensureWithinOverallBudget(event.timestamp, overallTimeoutMs);
            await ensureJobActive(this.env, input.jobId);
            const request = await createStageRequest(
              this.env,
              input,
              prepared,
              { stage: "plan" },
            );
            const result = await invokeStage(this.env, request);
            if (
              result.stage !== "plan" ||
              !("analysisCheckpoint" in result)
            ) {
              throw new NonRetryableError(
                result.stage === "plan" && "message" in result
                  ? result.message
                  : "Plan stage returned an invalid checkpoint.",
              );
            }
            const analysisKey = `${checkpointPrefix}/analysis.json`;
            const structureKey = `${checkpointPrefix}/structure.json`;
            const checkpoint: StructureCheckpoint = {
              structureCheckpoint: result.structureCheckpoint,
              pageIds: result.pageIds,
              navigation: result.navigation,
              runtimeFeatures: result.runtimeFeatures,
              writerHandoff: result.writerHandoff,
            };
            await Promise.all([
              this.env.DOCS_BUCKET.put(
                analysisKey,
                result.analysisCheckpoint,
                {
                  httpMetadata: {
                    contentType: "application/json; charset=utf-8",
                  },
                },
              ),
              this.env.DOCS_BUCKET.put(
                structureKey,
                JSON.stringify(checkpoint),
                {
                  httpMetadata: {
                    contentType: "application/json; charset=utf-8",
                  },
                },
              ),
            ]);
            return {
              analysisKey,
              structureKey,
              pageIds: result.pageIds,
              templatePageIds: templatePageIdsOf(result.structureCheckpoint),
            };
          },
        );
        analysis = { key: planned.analysisKey };
        structure = {
          key: planned.structureKey,
          pageIds: planned.pageIds,
          templatePageIds: planned.templatePageIds,
        };
      } else {
        analysis = await step.do(
          "analyze repository",
          boundedStepConfig(
            event.timestamp,
            overallTimeoutMs,
            positiveNumber(
              this.env.ANALYSIS_STAGE_TIMEOUT_MS,
              DEFAULT_ANALYSIS_TIMEOUT_MS,
            ),
          ),
          async () => {
            ensureWithinOverallBudget(event.timestamp, overallTimeoutMs);
            await ensureJobActive(this.env, input.jobId);
            const request = await createStageRequest(
              this.env,
              input,
              prepared,
              { stage: "analysis" },
            );
            const result = await invokeStage(this.env, request);
            if (result.stage !== "analysis") {
              throw new NonRetryableError(
                "Analysis stage returned an invalid checkpoint.",
              );
            }
            if (!("checkpoint" in result)) {
              throw new NonRetryableError(result.message);
            }
            const key = `${checkpointPrefix}/analysis.json`;
            await this.env.DOCS_BUCKET.put(key, result.checkpoint, {
              httpMetadata: {
                contentType: "application/json; charset=utf-8",
              },
            });
            return { key };
          },
        );

        structure = await step.do(
          "plan documentation structure",
          boundedStepConfig(
            event.timestamp,
            overallTimeoutMs,
            positiveNumber(
              this.env.STRUCTURE_STAGE_TIMEOUT_MS,
              DEFAULT_STRUCTURE_TIMEOUT_MS,
            ),
          ),
          async () => {
            ensureWithinOverallBudget(event.timestamp, overallTimeoutMs);
            await ensureJobActive(this.env, input.jobId);
            const analysisCheckpoint = await readCheckpointText(
              this.env.DOCS_BUCKET,
              analysis.key,
            );
            const request = await createStageRequest(
              this.env,
              input,
              prepared,
              {
                stage: "structure",
                analysisCheckpoint,
              },
            );
            const result = await invokeStage(this.env, request);
            if (result.stage !== "structure") {
              throw new NonRetryableError(
                "Structure stage returned an invalid checkpoint.",
              );
            }
            const key = `${checkpointPrefix}/structure.json`;
            const checkpoint: StructureCheckpoint = {
              structureCheckpoint: result.checkpoint,
              pageIds: result.pageIds,
              navigation: result.navigation,
              runtimeFeatures: result.runtimeFeatures,
              writerHandoff: result.writerHandoff,
            };
            await this.env.DOCS_BUCKET.put(
              key,
              JSON.stringify(checkpoint),
              {
                httpMetadata: {
                  contentType: "application/json; charset=utf-8",
                },
              },
            );
            return {
              key,
              pageIds: result.pageIds,
              templatePageIds: templatePageIdsOf(result.checkpoint),
            };
          },
        );
      }

      const modelGroupSize = resolveWriteGroupSize(this.env.DOXA_WRITE_GROUP_SIZE);
      const writeGroupTimeouts = resolveWriteGroupTimeouts(this.env);
      const writeGroups = planWriteGroups({
        pageIds: structure.pageIds,
        templatePageIds: structure.templatePageIds ?? [],
        modelGroupSize,
      });
      const batches = writeGroups.map((group) => group.pageIds);
      assertWritingStageFeasible({
        event,
        overallTimeoutMs,
        budget: writingBudgetOf(writeGroups, {
          modelGroupSize,
          timeouts: writeGroupTimeouts,
          batchParallelism: writeBatchParallelism,
        }),
        finalizationTimeoutMs: positiveNumber(
          this.env.FINALIZATION_TIMEOUT_MS,
          DEFAULT_FINALIZATION_TIMEOUT_MS,
        ),
      });
      const batchResults = await dispatchWorkflowBatches({
        batches: writeGroups,
        parallelism: writeBatchParallelism,
        step,
        isRunStopping: isRunStoppingError,
        stepName: (index, total, group) =>
          `write ${writeGroupNoun(group)} batch ${index + 1} of ${total}`,
        stepConfig: (_index, group) =>
          boundedStepConfig(
            event.timestamp,
            overallTimeoutMs,
            writeGroupTimeouts[group.kind],
          ),
        runBatch: async ({ pageIds }) => {
          ensureWithinOverallBudget(event.timestamp, overallTimeoutMs);
          await ensureJobActive(this.env, input.jobId);
          const analysisCheckpoint = await readCheckpointText(this.env.DOCS_BUCKET, analysis.key);
          const structureCheckpoint = await readStructureCheckpoint(this.env.DOCS_BUCKET, structure.key);
          const store = createR2GenerationPageCheckpointStore(
            this.env.DOCS_BUCKET,
            `${checkpointPrefix}/pages`,
          );
          return runResumablePageBatch({
            pageIds,
            store,
            generate: async (pendingPageIds, checkpoint) => {
              const request = await createStageRequest(this.env, input, prepared, {
                stage: "write",
                analysisCheckpoint,
                structureCheckpoint: structureCheckpoint.structureCheckpoint,
                writerHandoff: structureCheckpoint.writerHandoff,
                pageIds: [...pendingPageIds],
              });
              const result = await invokeStage(this.env, request, {
                onPageCheckpoint: checkpoint,
              });
              if (result.stage !== "write") {
                throw new NonRetryableError("Write stage returned an invalid checkpoint.");
              }
              return { pages: result.pages, failedPages: result.failedPages };
            },
          });
        },
      });
      const writeOutcome: PageBatchOutcome & { noticesKey?: string | null } = await step.do(
        "record flagged pages",
        boundedStepConfig(event.timestamp, overallTimeoutMs, 2 * 60_000),
        async () => {
          const structureCheckpoint = await readStructureCheckpoint(this.env.DOCS_BUCKET, structure.key);
          const outcome = collectPageBatchOutcomes(
            batches,
            batchResults,
            pageTitlesFromStructure(structureCheckpoint.structureCheckpoint),
          );
          assertPageFailureBudget(outcome.failedPages, structure.pageIds.length);
          // Every read comes before the flag events, so a failed read never
          // repeats them when the step is retried.
          const noticesKey = await this.storeNoticePayload(input.jobId, pageNoticePayloadKey(checkpointPrefix, "full"), {
            openIssueNotices: await this.collectOpenIssueNotices(input.jobId, outcome.keys),
            behindCandidates: [],
          });
          const { flaggedPages } = planWithFailedPages(
            { regeneratePageIds: [...structure.pageIds], reusePageIds: [] },
            outcome.failedPages,
            new Set(),
          );
          await recordFlaggedPages({
            flaggedPages,
            routeOf: () => undefined,
            addJobEvent: (flagEvent) => this.env.API.addJobEvent(input.jobId, flagEvent),
          });
          return { ...outcome, noticesKey };
        },
      );
      await this.recordNoticesStep(step, input.jobId, {
        name: "record page notices",
        config: bestEffortStepConfig(event.timestamp, overallTimeoutMs, 2 * 60_000),
        // Absent in step results recorded before page notices.
        noticesKey: writeOutcome.noticesKey ?? null,
        exhaustedPageIds: [],
      });
      const pageKeys = writeOutcome.keys;
      const failedPageIds = new Set(writeOutcome.failedPages.map((page) => page.id));

      const published = await step.do(
        "assemble upload and publish artifacts",
        boundedStepConfig(
          event.timestamp,
          overallTimeoutMs,
          positiveNumber(this.env.FINALIZATION_TIMEOUT_MS, DEFAULT_FINALIZATION_TIMEOUT_MS),
        ),
        async () => {
          ensureWithinOverallBudget(event.timestamp, overallTimeoutMs);
          await ensureJobActive(this.env, input.jobId);
          const structureCheckpoint = await readStructureCheckpoint(this.env.DOCS_BUCKET, structure.key);
          const checkpointedBatches = await Promise.all(
            pageKeys.map((key) => readPageCheckpoint(this.env.DOCS_BUCKET, key)),
          );
          const pages = assembleCheckpointedPages(
            structure.pageIds.filter((pageId) => !failedPageIds.has(pageId)),
            checkpointedBatches,
          );
          const navigation = finalizeRuntimeNavigation(
            structureCheckpoint.navigation,
            pages,
          );
          const bundle = await createRuntimeDocsArtifacts({
            siteId: prepared.context.project.siteId,
            versionId: prepared.versionId,
            projectSlug: prepared.context.project.slug,
            projectName: prepared.context.project.name,
            siteConfig: prepared.context.siteConfig,
            entitlements: prepared.context.entitlements,
            pages: pages.map(({ title, route, navigationPath, content }) => ({
              title,
              route,
              navigationPath,
              content,
            })),
            navigation,
            features: structureCheckpoint.runtimeFeatures,
          });
          validateArtifactFiles(bundle.files);
          await emitArtifactLinkWarnings(
            this.env,
            input.jobId,
            bundle.files,
            navigation,
          );
          const { artifactPrefix, manifestPath } = await writeArtifactVersion(
            this.env.DOCS_BUCKET,
            {
              siteId: prepared.context.project.siteId,
              versionId: prepared.versionId,
              files: bundle.files,
              beforeEachFile: () => ensureJobActive(this.env, input.jobId),
            },
          );
          await ensureJobActive(this.env, input.jobId);
          const result = await this.env.API.publishJobOutput(input.jobId, {
            artifactPrefix,
            manifestPath,
          });
          await this.env.API.addJobEvent(input.jobId, {
            type: "artifacts_published",
            message: "Generated documentation artifacts uploaded and published.",
            source: "worker",
            data: { fileCount: bundle.files.length, versionId: result.versionId },
          }).catch(() => undefined);
          await deleteCheckpointPrefix(this.env.DOCS_BUCKET, checkpointPrefix).catch(() => undefined);
          return result;
        },
      );

      await logUsageSummarySafely(this.env, input.jobId, "completed");
      return published;
    } catch (error) {
      const message = sanitizeErrorMessage(
        error instanceof Error ? error.message : "Durable generation workflow failed.",
        modelApiKeySecrets(this.env),
      );
      const active = await this.env.API.isJobActive(input.jobId).catch(() => false);
      if (active) {
        await this.env.API.markJobFailed(input.jobId, message).catch(() => undefined);
        await this.env.API.addJobEvent(input.jobId, {
          type: "workflow_failed",
          message,
          source: "worker",
        }).catch(() => undefined);
      }
      await requestAgentContainerDestroy(input.jobId, {
        agentContainerBinding: this.env.AGENT_CONTAINER,
        agentContainerUrl: this.env.AGENT_CONTAINER_URL,
      });
      await deleteCheckpointPrefix(this.env.DOCS_BUCKET, checkpointPrefix).catch(() => undefined);
      await logUsageSummarySafely(
        this.env,
        input.jobId,
        usageFailureStatus(error),
      );
      throw error instanceof NonRetryableError ? error : new NonRetryableError(message);
    }
  }

  /**
   * The notices of the pages the writer kept with open issues. Notices only
   * add information, so a failed checkpoint read gives none rather than a
   * failed step.
   */
  private async collectOpenIssueNotices(jobId: string, pageKeys: readonly string[]): Promise<PageNotice[]> {
    try {
      const writtenBatches = await Promise.all(
        pageKeys.map((key) => readPageCheckpoint(this.env.DOCS_BUCKET, key)),
      );
      return openIssueNotices(writtenBatches.flat());
    } catch (error) {
      logBestEffortStepError(jobId, "open_issue_notices", error);
      return [];
    }
  }

  /**
   * Stores the run's notices next to its checkpoints and gives their key.
   * The step result then carries only the key, however many pages and issues
   * there are. A failed write is logged and gives no notices, never a failed run.
   */
  private async storeNoticePayload(jobId: string, key: string, payload: PageNoticePayload): Promise<string | null> {
    try {
      return await storePageNoticePayload(this.env.DOCS_BUCKET, key, payload);
    } catch (error) {
      logBestEffortStepError(jobId, "page_notice_payload", error);
      return null;
    }
  }

  /**
   * Records the run's page notices in their own step, which runs once: it
   * reads the payload that an earlier step stored, adds the notices of the
   * pages that the ledger marks as exhausted, and logs and skips a failure.
   */
  private async recordNoticesStep(
    step: GenerationWorkflowStep,
    jobId: string,
    input: {
      name: string;
      config: ReturnType<typeof bestEffortStepConfig>;
      noticesKey: string | null;
      exhaustedPageIds: readonly string[];
    },
  ): Promise<void> {
    if (input.noticesKey === null) return;
    const noticesKey = input.noticesKey;
    await runBestEffortStep({
      step,
      name: input.name,
      config: input.config,
      fallback: undefined,
      onError: (error) => logBestEffortStepError(jobId, "page_notices", error),
      work: async () => {
        const payload = await readPageNoticePayload(this.env.DOCS_BUCKET, noticesKey);
        await recordPageNotices({
          notices: [
            ...payload.openIssueNotices,
            ...behindInstructionsNotices({ candidates: payload.behindCandidates, exhaustedPageIds: input.exhaustedPageIds }),
          ],
          addJobEvent: (noticeEvent) => this.env.API.addJobEvent(jobId, noticeEvent),
          onError: (_notice, error) => logBestEffortStepError(jobId, "page_notice", error),
        });
      },
    });
  }

  private async runRevisionAwareGeneration(
    event: Readonly<GenerationWorkflowEvent<GenerateJobMessage>>,
    workflowStep: GenerationWorkflowStep,
    context: GenerationExecutionContext,
    checkpointPrefix: string,
    overallTimeoutMs: number,
    writeBatchParallelism: number,
  ): Promise<
    | { versionId: string }
    | {
        outcome: "superseded" | "action_required";
        versionId: null;
      }
  > {
    const input = event.payload;
    const isPreview =
      context.job.publicationMode === "preview";
    const checkpointScope = isPreview
      ? "preview"
      : "production";
    const stepTracker = trackWorkflowSteps(workflowStep);
    const step = stepTracker.step;
    try {
      const prepared = await step.do(
        isPreview
          ? "prepare preview generation"
          : "prepare revision-aware production generation",
        boundedStepConfig(
          event.timestamp,
          overallTimeoutMs,
          5 * 60_000,
        ),
        async () => {
          ensureWithinOverallBudget(event.timestamp, overallTimeoutMs);
          const control = await this.env.API.getGenerationControl();
          if (control.status === "paused") {
            const message = control.reason
              ? `Generation is paused: ${control.reason}`
              : "Generation is paused.";
            await this.env.API.markJobCancelled(input.jobId, message);
            throw new NonRetryableError(message);
          }
          assertRevisionAwareExecutionContext(context);
          const executionConfig = resolveGenerationExecutionConfig(context);
          const { modelProvider } = await resolveStageModelAuth(this.env, this.env.API, [
            executionConfig.plannerModel,
            executionConfig.writerModel,
          ]);
          await this.env.API.markJobRunning(input.jobId);
          await this.env.API.addJobEvent(input.jobId, {
            type: isPreview
              ? "preview_workflow_started"
              : "production_workflow_started",
            message: isPreview
              ? "Incremental documentation preview workflow started."
              : "Revision-aware production documentation workflow started.",
            source: "worker",
            data: {
              repositoryFullName: context.repository.fullName,
              targetRevision: context.job.targetRevision,
              baselineVersionId: context.job.baselineVersionId,
              writeBatchParallelism,
              modelProvider,
              ...executionConfig,
            },
          });
          return { versionId: crypto.randomUUID() };
        },
      );

      if (isPreview) {
        const revision = await step.do(
          "validate current pull request revision",
          boundedStepConfig(
            event.timestamp,
            overallTimeoutMs,
            5 * 60_000,
          ),
          async () => {
            ensureWithinOverallBudget(
              event.timestamp,
              overallTimeoutMs,
            );
            await ensureJobActive(this.env, input.jobId);
            const current =
              await this.env.API.getCurrentChangeProposalState(
                input.jobId,
              );
            if (!current) {
              throw new NonRetryableError(
                "The current pull request state could not be resolved.",
              );
            }
            if (!isAcceptedPullRequestRevision(context, current)) {
              const message =
                "This documentation preview was superseded by a newer pull request state.";
              await this.env.API.markJobSuperseded(
                input.jobId,
                message,
              );
              await updatePreviewReviewRun(this.env, context, {
                state: "cancelled",
                title: "Documentation preview superseded",
                summary:
                  "A newer pull request revision is available, so this preview was cancelled.",
                detailsUrl: null,
              });
              return { eligible: false as const };
            }
            await updatePreviewReviewRun(this.env, context, {
              state: "in_progress",
              title: "Generating documentation preview",
              summary:
                "Doxa is analyzing this pull request and updating affected documentation pages.",
              detailsUrl: null,
            });
            return { eligible: true as const };
          },
        );
        if (!revision.eligible) {
          return { outcome: "superseded", versionId: null };
        }
      }

      let planning:
        | {
            outcome: "merge_conflict";
            targetRevision: string;
            message: string;
          }
        | {
            outcome: "ready";
            analysisKey: string;
            structureKey: string;
            pageIds: string[];
            regeneratePageIds: string[];
            /** Absent in step results recorded before template groups. */
            templatePageIds?: string[];
          };

      if (isPlanStageEnabled(this.env.DOXA_PLAN_STAGE_ENABLED)) {
        planning = await step.do(
          isPreview
            ? "plan exact preview revision"
            : "plan exact production revision",
          boundedStepConfig(
            event.timestamp,
            overallTimeoutMs,
            combinedPlanningTimeoutMs(this.env),
          ),
          async () => {
            ensureWithinOverallBudget(event.timestamp, overallTimeoutMs);
            await ensureJobActive(this.env, input.jobId);
            const reusableState = await loadReusableState(
              this.env.DOCS_BUCKET,
              context,
            );
            const request = await createRevisionAwareStageRequest(
              this.env,
              input,
              context,
              prepared.versionId,
              reusableState,
              { stage: "plan" },
            );
            const result = await invokePlanStageWithCache(
              this.env,
              request,
              event.timestamp.toISOString(),
            );
            if (result.stage !== "plan") {
              throw new NonRetryableError(
                "Plan stage returned an invalid checkpoint.",
              );
            }
            if (!("analysisCheckpoint" in result)) {
              return {
                outcome: "merge_conflict" as const,
                targetRevision: result.targetRevision,
                message: result.message,
              };
            }
            requireIncrementalPlanResult(result);
            const analysisKey =
              `${checkpointPrefix}/${checkpointScope}-analysis.json`;
            const structureKey =
              `${checkpointPrefix}/${checkpointScope}-structure.json`;
            const analysisResult = analysisStageResultFromPlan(result);
            const structureResult = withPageLocks(
              structureStageResultFromPlan(result),
              context,
              reusableState,
              result.snapshot?.changes,
              analysisResult.analysisState.projectInstructionsFingerprint,
            );
            await Promise.all([
              this.env.DOCS_BUCKET.put(
                analysisKey,
                JSON.stringify(analysisResult),
                {
                  httpMetadata: {
                    contentType: "application/json; charset=utf-8",
                  },
                },
              ),
              this.env.DOCS_BUCKET.put(
                structureKey,
                JSON.stringify(structureResult),
                {
                  httpMetadata: {
                    contentType: "application/json; charset=utf-8",
                  },
                },
              ),
            ]);
            return {
              outcome: "ready" as const,
              analysisKey,
              structureKey,
              pageIds: result.pageIds,
              regeneratePageIds: structureResult.plan.regeneratePageIds,
              templatePageIds: templatePageIdsOf(structureResult.checkpoint),
            };
          },
        );
      } else {
        const legacyAnalysis = await step.do(
          isPreview
            ? "analyze exact preview revision"
            : "analyze exact production revision",
          boundedStepConfig(
            event.timestamp,
            overallTimeoutMs,
            positiveNumber(
              this.env.ANALYSIS_STAGE_TIMEOUT_MS,
              DEFAULT_ANALYSIS_TIMEOUT_MS,
            ),
          ),
          async () => {
            ensureWithinOverallBudget(event.timestamp, overallTimeoutMs);
            await ensureJobActive(this.env, input.jobId);
            const reusableState = await loadReusableState(
              this.env.DOCS_BUCKET,
              context,
            );
            const request = await createRevisionAwareStageRequest(
              this.env,
              input,
              context,
              prepared.versionId,
              reusableState,
              { stage: "analysis" },
            );
            const result = await invokeStage(this.env, request);
            if (result.stage !== "analysis") {
              throw new NonRetryableError(
                "Analysis stage returned an invalid checkpoint.",
              );
            }
            if (!("checkpoint" in result)) {
              return {
                outcome: "merge_conflict" as const,
                targetRevision: result.targetRevision,
                message: result.message,
              };
            }
            requireIncrementalAnalysisResult(result);
            const key =
              `${checkpointPrefix}/${checkpointScope}-analysis.json`;
            await this.env.DOCS_BUCKET.put(
              key,
              JSON.stringify(result),
              {
                httpMetadata: {
                  contentType: "application/json; charset=utf-8",
                },
              },
            );
            return { outcome: "ready" as const, key };
          },
        );

        if (legacyAnalysis.outcome === "merge_conflict") {
          planning = legacyAnalysis;
        } else {
          const legacyStructure = await step.do(
            isPreview
              ? "plan incremental documentation structure"
              : "plan production documentation structure",
            boundedStepConfig(
              event.timestamp,
              overallTimeoutMs,
              positiveNumber(
                this.env.STRUCTURE_STAGE_TIMEOUT_MS,
                DEFAULT_STRUCTURE_TIMEOUT_MS,
              ),
            ),
            async () => {
              ensureWithinOverallBudget(
                event.timestamp,
                overallTimeoutMs,
              );
              await ensureJobActive(this.env, input.jobId);
              const analysisResult = await readAnalysisStageResult(
                this.env.DOCS_BUCKET,
                legacyAnalysis.key,
              );
              const reusableState = await loadReusableState(
                this.env.DOCS_BUCKET,
                context,
              );
              const request = await createRevisionAwareStageRequest(
                this.env,
                input,
                context,
                prepared.versionId,
                reusableState,
                {
                  stage: "structure",
                  analysisCheckpoint: analysisResult.checkpoint,
                  sourceState: analysisResult.sourceState,
                  analysisState: analysisResult.analysisState,
                  preliminaryPlan: analysisResult.preliminaryPlan,
                  structuralFingerprint:
                    analysisResult.structuralFingerprint,
                },
              );
              const result = await invokeStage(this.env, request);
              if (result.stage !== "structure") {
                throw new NonRetryableError(
                  "Structure stage returned an invalid checkpoint.",
                );
              }
              requireIncrementalStructureResult(result);
              const structureResult = withPageLocks(
                result,
                context,
                reusableState,
                analysisResult.snapshot?.changes,
                analysisResult.analysisState.projectInstructionsFingerprint,
              );
              const key =
                `${checkpointPrefix}/${checkpointScope}-structure.json`;
              await this.env.DOCS_BUCKET.put(
                key,
                JSON.stringify(structureResult),
                {
                  httpMetadata: {
                    contentType: "application/json; charset=utf-8",
                  },
                },
              );
              return {
                key,
                pageIds: structureResult.pageIds,
                regeneratePageIds: structureResult.plan.regeneratePageIds,
                templatePageIds: templatePageIdsOf(structureResult.checkpoint),
              };
            },
          );
          planning = {
            outcome: "ready",
            analysisKey: legacyAnalysis.key,
            structureKey: legacyStructure.key,
            pageIds: legacyStructure.pageIds,
            regeneratePageIds: legacyStructure.regeneratePageIds,
            templatePageIds: legacyStructure.templatePageIds,
          };
        }
      }

      if (planning.outcome === "merge_conflict") {
        if (!isPreview) {
          throw new NonRetryableError(planning.message);
        }
        await step.do(
          "report preview merge conflict",
          boundedStepConfig(
            event.timestamp,
            overallTimeoutMs,
            2 * 60_000,
          ),
          async () => {
            await this.env.API.markJobFailed(
              input.jobId,
              planning.message,
            );
            await updatePreviewReviewRun(this.env, context, {
              state: "action_required",
              title: "Documentation preview needs a clean merge",
              summary:
                "The pull request conflicts with its accepted base revision. Resolve the merge conflict before Doxa can generate a preview.",
              detailsUrl: null,
            });
          },
        );
        return { outcome: "action_required", versionId: null };
      }

      const analysis = { key: planning.analysisKey };
      const structure = {
        key: planning.structureKey,
        pageIds: planning.pageIds,
        regeneratePageIds: planning.regeneratePageIds,
      };

      const modelGroupSize = resolveWriteGroupSize(this.env.DOXA_WRITE_GROUP_SIZE);
      const writeGroupTimeouts = resolveWriteGroupTimeouts(this.env);
      const writeGroups = planWriteGroups({
        pageIds: structure.regeneratePageIds,
        templatePageIds: planning.templatePageIds ?? [],
        modelGroupSize,
      });
      const batches = writeGroups.map((group) => group.pageIds);
      const jobWriterCeiling = positiveNumber(
        this.env.DOXA_AGENT_PAGE_CONCURRENCY,
        DEFAULT_JOB_WRITER_CEILING,
      );
      const writerSlots = resolveWriterSlotLimiter(this.env);
      assertWritingStageFeasible({
        event,
        overallTimeoutMs,
        budget: writingBudgetOf(writeGroups, {
          modelGroupSize,
          timeouts: writeGroupTimeouts,
          batchParallelism: writeBatchParallelism,
        }),
        finalizationTimeoutMs: positiveNumber(
          this.env.FINALIZATION_TIMEOUT_MS,
          DEFAULT_FINALIZATION_TIMEOUT_MS,
        ),
      });
      const batchCacheContexts = await preparePageBatchCacheContexts({
        batches,
        build: async (pageIds) => {
          if (!isPageCacheEnabled(this.env.DOXA_PAGE_CACHE_ENABLED)) {
            return undefined;
          }
          try {
            const [analysisResult, structureResult] = await Promise.all([
              readAnalysisStageResult(
                this.env.DOCS_BUCKET,
                analysis.key,
              ),
              readStructureStageResult(
                this.env.DOCS_BUCKET,
                structure.key,
              ),
            ]);
            return await createPageBatchCacheContext({
              env: this.env,
              context,
              isPreview,
              pageIds,
              analysisResult,
              structureResult,
              createdAt: event.timestamp.toISOString(),
            });
          } catch (error) {
            logPageCacheError(input.jobId, "prepare", error);
            return undefined;
          }
        },
      });
      const batchResults = await dispatchWorkflowBatches({
        batches: writeGroups,
        parallelism: writeBatchParallelism,
        step,
        isRunStopping: isRunStoppingError,
        stepName: (index, total, group) =>
          `write affected ${checkpointScope} ${writeGroupNoun(group)} batch ${index + 1} of ${total}`,
        stepConfig: (_index, group) =>
          boundedStepConfig(
            event.timestamp,
            overallTimeoutMs,
            writeGroupTimeouts[group.kind],
          ),
        runBatch: async ({ kind, pageIds }, batchIndex) => {
          ensureWithinOverallBudget(
            event.timestamp,
            overallTimeoutMs,
          );
          // Each setup call has a name and a time limit, so a failure says
          // which call broke and not only "internal error".
          const setupCall = <T,>(call: string, run: () => Promise<T>) =>
            withStepCallDeadline({ call, jobId: input.jobId }, run);
          await setupCall("job status check", () =>
            ensureJobActive(this.env, input.jobId),
          );
          const analysisResult = await setupCall("analysis checkpoint read", () =>
            readAnalysisStageResult(this.env.DOCS_BUCKET, analysis.key),
          );
          const structureResult = await setupCall("structure checkpoint read", () =>
            readStructureStageResult(this.env.DOCS_BUCKET, structure.key),
          );
          const store = createR2GenerationPageCheckpointStore(
            this.env.DOCS_BUCKET,
            `${checkpointPrefix}/${checkpointScope}-pages`,
          );
          const cacheContext = batchCacheContexts[batchIndex];
          // One lease per job: each model group asks again, which renews it.
          // A template group calls no model, so it takes no writer slot.
          const writerSlotLease = kind === "template"
            ? NO_WRITER_SLOT_LEASE
            : await setupCall("writer slot lease", () =>
              acquireWriterSlots(writerSlots, {
                jobId: input.jobId,
                requested: jobWriterCeiling,
                ttlMs: writeGroupTimeouts.model + WRITER_SLOT_TTL_MARGIN_MS,
              }),
            );
          const batchResult = await runPageBatchWithCache({
            pageIds,
            store,
            ...(cacheContext ? { cacheContext } : {}),
            generate: async (pendingPageIds, checkpoint) => {
              // The writer edits a published page instead of writing it again.
              const previousPages = await setupCall("published page read", () =>
                readPreviousPages(
                  (key) => readArtifactText(this.env.DOCS_BUCKET, key),
                  structureResult.plan?.pageEdits,
                  pendingPageIds,
                ),
              );
              const request = await setupCall("stage request setup", () =>
                createRevisionAwareStageRequest(
                  this.env,
                  input,
                  context,
                  prepared.versionId,
                  undefined,
                  {
                    stage: "write",
                    analysisCheckpoint: analysisResult.checkpoint,
                    structureCheckpoint: structureResult.checkpoint,
                    writerHandoff: structureResult.writerHandoff,
                    pageIds: [...pendingPageIds],
                    ...(writerSlotLease.granted > 0 ? { writerSlots: writerSlotLease.granted } : {}),
                    ...(Object.keys(previousPages).length > 0 ? { previousPages } : {}),
                  },
                ),
              );
              const result = await invokeStage(this.env, request, {
                onPageCheckpoint: checkpoint,
              });
              if (result.stage !== "write") {
                throw new NonRetryableError(
                  "Write stage returned an invalid checkpoint.",
                );
              }
              return { pages: result.pages, failedPages: result.failedPages };
            },
          });
          logPageCacheBatchSummary({
            jobId: input.jobId,
            pageCount: pageIds.length,
            result: batchResult,
          });
          return { ...batchResult, writerSlotLeaseId: writerSlotLease.leaseId };
        },
      });
      await step.do(
        `release ${checkpointScope} writer slots`,
        boundedStepConfig(event.timestamp, overallTimeoutMs, 60_000),
        () => releaseWriterSlotLeases(writerSlots, batchResults),
      );
      const recordedWriteOutcome: RecordedWritePhaseOutcome = await step.do(
        `record flagged ${checkpointScope} pages`,
        boundedStepConfig(event.timestamp, overallTimeoutMs, 2 * 60_000),
        async (): Promise<WritePhaseOutcome> => {
          // Every read comes before the flag events, so a failed read never
          // repeats them when the step is retried.
          const [analysisResult, structureResult] = await Promise.all([
            readAnalysisStageResult(this.env.DOCS_BUCKET, analysis.key),
            readStructureStageResult(this.env.DOCS_BUCKET, structure.key),
          ]);
          const outcome = collectPageBatchOutcomes(
            batches,
            batchResults,
            pageTitlesFromStructure(structureResult.checkpoint),
          );
          const budgeted = failuresUnderBudget({
            failedPages: outcome.failedPages,
            regeneratePageIds: structure.regeneratePageIds,
            catchUpPageIds: structureResult.plan.catchUpPageIds,
          });
          const failedPageIds = new Set(outcome.failedPages.map((page) => page.id));
          const writtenPageIds = structure.regeneratePageIds.filter((pageId) => !failedPageIds.has(pageId));
          const reusableState = await loadReusableState(this.env.DOCS_BUCKET, context);
          const baselinePages = baselinePageStates(reusableState);
          const runFingerprint = analysisResult.analysisState.projectInstructionsFingerprint;
          const previousRunFingerprint = reusableState?.analysis.projectInstructionsFingerprint;
          const noticesKey = await this.storeNoticePayload(input.jobId, pageNoticePayloadKey(checkpointPrefix, checkpointScope), {
            openIssueNotices: await this.collectOpenIssueNotices(input.jobId, outcome.keys),
            behindCandidates: behindInstructionCandidates({
              previousPages: reusableState?.pages ?? [],
              previousRunFingerprint,
              runFingerprint,
              currentPageIds: structure.pageIds,
              writtenPageIds,
              lockedHrefs: lockedHrefsOf(context),
            }),
          });
          // The budget decides in its own step after the ledger step, so a
          // run that stops still counts its catch-up failures; it records no flags.
          if (!isPageFailureBudgetExceeded(budgeted.failedPages.length, budgeted.plannedCount)) {
            const { flaggedPages } = planWithFailedPages(
              structureResult.plan,
              outcome.failedPages,
              new Set(baselinePages.keys()),
            );
            await recordFlaggedPages({
              flaggedPages,
              routeOf: (pageId) => baselinePages.get(pageId)?.route,
              addJobEvent: (flagEvent) => this.env.API.addJobEvent(input.jobId, flagEvent),
            });
          }
          return {
            ...outcome,
            budgeted,
            writtenPageIds,
            runFingerprint: runFingerprint ?? null,
            catchUpPageIds: structureResult.plan.catchUpPageIds ?? [],
            publishedBehindPageIds: publishedBehindPageIds({
              previousPages: reusableState?.pages ?? [],
              previousRunFingerprint,
              currentPageIds: structure.pageIds,
            }),
            noticesKey,
          };
        },
      );
      const writeOutcome = writePhaseOutcomeOf(recordedWriteOutcome, structure.regeneratePageIds);
      const writtenPageIds = writeOutcome.writtenPageIds;
      const exhaustedCatchUpPageIds = await settleWritePhase({
        recordCatchUp: () => runBestEffortStep({
          step,
          name: `record ${checkpointScope} instruction catch-up`,
          config: bestEffortStepConfig(event.timestamp, overallTimeoutMs, 60_000),
          fallback: [],
          onError: (error) => logBestEffortStepError(input.jobId, "instruction_catch_up", error),
          work: async () => {
            const runFingerprint = writeOutcome.runFingerprint;
            if (runFingerprint === null) return [];
            if (!isPreview) await ensureJobActive(this.env, input.jobId);
            return recordInstructionCatchUp({
              bucket: this.env.DOCS_BUCKET,
              siteId: context.project.siteId,
              jobId: input.jobId,
              runFingerprint,
              writeLedger: !isPreview,
              catchUpPageIds: writeOutcome.catchUpPageIds,
              failedPageIds: new Set(writeOutcome.failedPages.map((page) => page.id)),
              behindPageIds: new Set([...writeOutcome.publishedBehindPageIds, ...writeOutcome.catchUpPageIds]),
            });
          },
        }),
        checkPageFailureBudget: () => checkPageFailureBudgetStep({
          step,
          name: `check ${checkpointScope} page failure budget`,
          config: boundedStepConfig(event.timestamp, overallTimeoutMs, 60_000),
          budgeted: writeOutcome.budgeted,
        }),
        recordNotices: (exhaustedPageIds) => this.recordNoticesStep(step, input.jobId, {
          name: `record ${checkpointScope} page notices`,
          config: bestEffortStepConfig(event.timestamp, overallTimeoutMs, 2 * 60_000),
          noticesKey: writeOutcome.noticesKey,
          exhaustedPageIds,
        }),
      });
      const pageKeys = writeOutcome.keys;
      /** The plan without the failed pages, which the site keeps or leaves out. */
      const withFailedPages = (
        plan: IncrementalGenerationPlan,
        reusableState: ReusableGenerationState | undefined,
      ) =>
        planWithFailedPages(
          plan,
          writeOutcome.failedPages,
          new Set(baselinePageStates(reusableState).keys()),
        );

      const assembled = await step.do(
        isPreview
          ? "assemble and upload incremental preview artifacts"
          : "assemble and upload production artifacts",
        boundedStepConfig(
          event.timestamp,
          overallTimeoutMs,
          positiveNumber(
            this.env.FINALIZATION_TIMEOUT_MS,
            DEFAULT_FINALIZATION_TIMEOUT_MS,
          ),
        ),
        async () => {
          ensureWithinOverallBudget(event.timestamp, overallTimeoutMs);
          await ensureJobActive(this.env, input.jobId);
          const analysisResult = await readAnalysisStageResult(
            this.env.DOCS_BUCKET,
            analysis.key,
          );
          const structureResult = await readStructureStageResult(
            this.env.DOCS_BUCKET,
            structure.key,
          );
          const generatedBatches = await Promise.all(
            pageKeys.map((key) =>
              readPageCheckpoint(this.env.DOCS_BUCKET, key)
            ),
          );
          const reusableState = await loadReusableState(
            this.env.DOCS_BUCKET,
            context,
          );
          const { plan, leftOutPageIds } = withFailedPages(
            structureResult.plan,
            reusableState,
          );
          const reusedPages = await loadReusablePages(
            this.env.DOCS_BUCKET,
            context,
            reusableState,
            plan,
          );
          const pages = assembleIncrementalPages(
            structureResult.pageIds.filter((pageId) => !leftOutPageIds.has(pageId)),
            generatedBatches,
            reusedPages,
            plan,
          );
          const navigation = finalizeRuntimeNavigation(
            structureResult.navigation,
            pages,
          );
          const bundle = await createRuntimeDocsArtifacts({
            siteId: context.project.siteId,
            versionId: prepared.versionId,
            projectSlug: context.project.slug,
            projectName: context.project.name,
            siteConfig: context.siteConfig,
            entitlements: context.entitlements,
            pages: pages.map(
              ({
                title,
                route,
                navigationPath,
                content,
              }) => ({
                title,
                route,
                navigationPath,
                content,
              }),
            ),
            navigation,
            features: structureResult.runtimeFeatures,
          });
          validateArtifactFiles(bundle.files);
          await emitArtifactLinkWarnings(
            this.env,
            input.jobId,
            bundle.files,
            navigation,
          );
          const { artifactPrefix, manifestPath } = await writeArtifactVersion(
            this.env.DOCS_BUCKET,
            {
              siteId: context.project.siteId,
              versionId: prepared.versionId,
              files: bundle.files,
              beforeEachFile: () => ensureJobActive(this.env, input.jobId),
            },
          );
          const briefOf = pageBriefFingerprints({
            plan,
            runBriefFingerprint:
              analysisResult.analysisState.documentationBriefFingerprint,
            previousPages: reusableState?.pages ?? [],
          });
          const instructionsOf = pageInstructionsFingerprints({
            plan,
            runFingerprint:
              analysisResult.analysisState.projectInstructionsFingerprint,
            previousPages: reusableState?.pages ?? [],
            // A state from before the field had no instructions.
            previousRunFingerprint: reusableState
              ? reusableState.analysis.projectInstructionsFingerprint ??
                NO_PROJECT_INSTRUCTIONS_FINGERPRINT
              : undefined,
          });
          const pageStates = pages.map((page) => {
            const briefFingerprint = briefOf(page.id);
            const projectInstructionsFingerprint = instructionsOf(page.id);
            return generationPageStateSchema.parse({
              schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
              pageId: page.id,
              title: page.title,
              route: page.route,
              navigationPath: page.navigationPath,
              artifactKey:
                `${artifactPrefix}/${sourcePathForHref(page.route)}`,
              contentHash: page.contentHash,
              pageInputHash: page.pageInputHash,
              dependencies: page.dependencies,
              ...(briefFingerprint ? { briefFingerprint } : {}),
              ...(projectInstructionsFingerprint
                ? { projectInstructionsFingerprint }
                : {}),
            });
          });
          const finalizationKey =
            `${checkpointPrefix}/${checkpointScope}-finalization.json`;
          await this.env.DOCS_BUCKET.put(
            finalizationKey,
            JSON.stringify({
              pageStates,
              artifactPrefix,
              manifestPath,
              sourceRevision: analysisResult.snapshot.targetRevision,
              sourceTreeHash: analysisResult.snapshot.sourceTreeHash,
              changedSourceCount:
                analysisResult.snapshot.changes.length,
              regeneratedPageCount: plan.regeneratePageIds.length,
              reusedPageCount: plan.reusePageIds.length,
              flaggedPageCount: writeOutcome.failedPages.length,
            }),
            {
              httpMetadata: {
                contentType: "application/json; charset=utf-8",
              },
            },
          );
          return { finalizationKey };
        },
      );

      const permanentState = await step.do(
        isPreview
          ? "persist permanent preview generation state"
          : "persist permanent production generation state",
        boundedStepConfig(
          event.timestamp,
          overallTimeoutMs,
          5 * 60_000,
        ),
        async () => {
          await ensureJobActive(this.env, input.jobId);
          const analysisResult = await readAnalysisStageResult(
            this.env.DOCS_BUCKET,
            analysis.key,
          );
          const structureResult = await readStructureStageResult(
            this.env.DOCS_BUCKET,
            structure.key,
          );
          const finalization = await readFinalizationCheckpoint(
            this.env.DOCS_BUCKET,
            assembled.finalizationKey,
          );
          const store = new GenerationStateStore(
            createR2GenerationStateStorage(this.env.DOCS_BUCKET),
          );
          const executionConfig =
            resolveGenerationExecutionConfig(context);
          await store.write({
            siteId: context.project.siteId,
            versionId: prepared.versionId,
            baselineVersionId: context.job.baselineVersionId,
            generatorFingerprint:
              requiredGeneratorFingerprint(context),
            planningFingerprint:
              executionConfig.planningFingerprint,
            writingFingerprint:
              executionConfig.writingFingerprint,
            source: analysisResult.sourceState,
            analysis: analysisResult.analysisState,
            structure: structureResult.structureState,
            pages: finalization.pageStates,
            createdAt: event.timestamp.toISOString(),
            ...behindInstructionsField(
              finalization.pageStates,
              analysisResult.analysisState.projectInstructionsFingerprint,
              lockedHrefsOf(context),
              new Set(exhaustedCatchUpPageIds),
            ),
          });
          return {
            generationStatePrefix: generationStatePrefix(
              context.project.siteId,
              prepared.versionId,
            ),
          };
        },
      );

      const completed = await step.do(
        isPreview
          ? "complete isolated preview version"
          : "publish revision-aware production version",
        boundedStepConfig(
          event.timestamp,
          overallTimeoutMs,
          5 * 60_000,
        ),
        async () => {
          const finalization = await readFinalizationCheckpoint(
            this.env.DOCS_BUCKET,
            assembled.finalizationKey,
          );
          const completionState = {
            versionId: prepared.versionId,
            artifactPrefix: finalization.artifactPrefix,
            manifestPath: finalization.manifestPath,
            generationStatePrefix:
              permanentState.generationStatePrefix,
            sourceRevision: finalization.sourceRevision,
            sourceTreeHash: finalization.sourceTreeHash,
            changedSourceCount:
              finalization.changedSourceCount,
            regeneratedPageCount:
              finalization.regeneratedPageCount,
            reusedPageCount: finalization.reusedPageCount,
          };
          if (!isPreview) {
            const [structureResult, reusableState] = await Promise.all([
              readStructureStageResult(this.env.DOCS_BUCKET, structure.key),
              loadReusableState(this.env.DOCS_BUCKET, context),
            ]);
            return this.env.API.completeJobOutput(
              input.jobId,
              createProductionCompletionInput(context, {
                ...completionState,
                ownedPageFlags: lockedPageFlagsOf(
                  structureResult.plan,
                  reusableState?.pages ?? [],
                ),
                pageSources: pageSourcesOf(
                  withFailedPages(structureResult.plan, reusableState).plan,
                  finalization.pageStates,
                ),
              }),
            );
          }
          const proposal = requiredChangeProposal(context);
          const provider = requiredSourceProvider(context);
          return this.env.API.completeJobOutput(input.jobId, {
            publicationMode: "preview",
            ...completionState,
            baselineVersionId: context.job.baselineVersionId,
            generatorFingerprint:
              requiredGeneratorFingerprint(context),
            provider,
            changeExternalId: proposal.externalId,
            changeNumber: proposal.number,
            expectedHeadRevision:
              requiredTargetRevision(context),
            expectedPreviewVersionId:
              context.currentPreviewVersionId,
          });
        },
      );

      if (isPreview) {
        await step.do(
          "report successful documentation preview",
          boundedStepConfig(
            event.timestamp,
            overallTimeoutMs,
            2 * 60_000,
          ),
          async () => {
            const finalization =
              await readFinalizationCheckpoint(
                this.env.DOCS_BUCKET,
                assembled.finalizationKey,
              );
            await updatePreviewReviewRun(this.env, context, {
              state: "success",
              title: "Documentation preview ready",
              summary: previewSuccessSummary(finalization),
              detailsUrl: completed.previewUrl,
              metrics: {
                changedSourceCount:
                  finalization.changedSourceCount,
                regeneratedPageCount:
                  finalization.regeneratedPageCount,
                reusedPageCount:
                  finalization.reusedPageCount,
              },
            });
          },
        );
      }

      await step.do(
        isPreview
          ? "cleanup transient preview checkpoints"
          : "cleanup transient production checkpoints",
        boundedStepConfig(
          event.timestamp,
          overallTimeoutMs,
          2 * 60_000,
        ),
        () =>
          deleteCheckpointPrefix(
            this.env.DOCS_BUCKET,
            checkpointPrefix,
          ),
      );
      return { versionId: completed.versionId };
    } catch (error) {
      const message = sanitizeErrorMessage(
        error instanceof Error
          ? error.message
          : "Revision-aware generation workflow failed.",
        modelApiKeySecrets(this.env),
      );
      await step.do(
        isPreview
          ? "report failed documentation preview"
          : "report failed production generation",
        boundedStepConfig(
          event.timestamp,
          overallTimeoutMs,
          2 * 60_000,
        ),
        async () => {
          const active = await this.env.API
            .isJobActive(input.jobId)
            .catch(() => false);
          if (!active) {
            return;
          }
          await this.env.API.markJobFailed(input.jobId, message);
          const failedStep = stepTracker.failureOf(error);
          if (failedStep) {
            await this.env.API.addJobEvent(input.jobId, {
              type: WORKFLOW_STEP_FAILED_EVENT_TYPE,
              message: failedStep.resumable
                ? `The run stopped at "${failedStep.stepName}" and can continue from there.`
                : `The run stopped at "${failedStep.stepName}".`,
              source: "worker",
              data: failedStep,
            }).catch(() => undefined);
          }
          if (isPreview) {
            await updatePreviewReviewRun(this.env, context, {
              state: "failure",
              title: "Documentation preview failed",
              summary: message,
              detailsUrl: null,
            }).catch(() => undefined);
          }
        },
      );
      await step.do(
        isPreview
          ? "destroy failed preview container"
          : "destroy failed production container",
        boundedStepConfig(
          event.timestamp,
          overallTimeoutMs,
          2 * 60_000,
        ),
        () =>
          requestAgentContainerDestroy(input.jobId, {
            agentContainerBinding: this.env.AGENT_CONTAINER,
            agentContainerUrl: this.env.AGENT_CONTAINER_URL,
          }),
      );
      throw error instanceof NonRetryableError
        ? error
        : new NonRetryableError(message);
    }
  }
}

function assertRevisionAwareExecutionContext(
  context: GenerationExecutionContext,
): void {
  if (context.job.publicationMode === "production") {
    if (
      !isProductionTrigger(context.job.trigger) ||
      !context.job.targetRevision ||
      !context.job.plannerModel ||
      !context.job.writerModel ||
      !context.job.planningFingerprint ||
      !context.job.writingFingerprint ||
      !context.job.generationProfile ||
      !context.job.generatorFingerprint
    ) {
      throw new NonRetryableError(
        "Production generation context is incomplete.",
      );
    }
    return;
  }

  if (
    context.job.trigger !== "doxabot" ||
    context.job.publicationMode !== "preview" ||
    context.job.sourceProvider !== "github" ||
    !context.job.sourceInstallationExternalId ||
    !context.job.changeExternalId ||
    !context.job.targetRevision ||
    // No baseline is valid: after the generation cache was cleared, a
    // preview analyzes from scratch, like a first production run.
    !context.job.plannerModel ||
    !context.job.writerModel ||
    !context.job.planningFingerprint ||
    !context.job.writingFingerprint ||
    !context.job.generationProfile ||
    !context.job.generatorFingerprint ||
    !context.changeProposal
  ) {
    throw new NonRetryableError(
      "Preview generation context is incomplete.",
    );
  }
  if (context.repository.isPrivate !== true) {
    throw new NonRetryableError(
      "Doxabot previews are disabled for public repositories.",
    );
  }
  if (
    context.job.sourceInstallationExternalId !==
    context.repository.installationId
  ) {
    throw new NonRetryableError(
      "Preview generation installation identity is invalid.",
    );
  }
  if (
    context.changeProposal.externalId !==
      context.job.changeExternalId ||
    context.changeProposal.headRevision !==
      context.job.targetRevision
  ) {
    throw new NonRetryableError(
      "Preview generation revision identity is invalid.",
    );
  }
}

async function createRevisionAwareStageRequest(
  env: Env,
  input: GenerateJobMessage,
  context: GenerationExecutionContext,
  versionId: string,
  reusableState: ReusableGenerationState | undefined,
  stage:
    | { stage: "analysis" }
    | { stage: "plan" }
    | {
        stage: "structure";
        analysisCheckpoint: string;
        sourceState: SuccessfulAnalysisStageResult["sourceState"];
        analysisState: SuccessfulAnalysisStageResult["analysisState"];
        preliminaryPlan:
          SuccessfulAnalysisStageResult["preliminaryPlan"];
        structuralFingerprint:
          SuccessfulAnalysisStageResult["structuralFingerprint"];
      }
    | {
        stage: "write";
        analysisCheckpoint: string;
        structureCheckpoint: string;
        writerHandoff?: WriterHandoffManifest;
        pageIds: string[];
        /** The writer slots that the account-wide limiter granted the job. */
        writerSlots?: number;
        /** Published pages that the writer edits, by page ID. */
        previousPages?: Record<string, PreviousPageText>;
      },
): Promise<ContainerGenerationStageRequest> {
  const installationAccessToken =
    await env.API.createRepositoryReadToken(context.project.id);
  const executionConfig =
    resolveGenerationExecutionConfig(context);
  const models = resolveGenerationModels(env, executionConfig);
  const base: ContainerGenerateRequest = {
    jobId: input.jobId,
    repositoryFullName: context.repository.fullName,
    defaultBranch: context.repository.defaultBranch,
    installationAccessToken,
    ...(await resolveStageModelAuth(env, env.API, generationModelIds(models))),
    model: modelForGenerationStage(executionConfig, stage.stage),
    modelConfig: models,
    stageExecutionId: crypto.randomUUID(),
    generationProfile: executionConfig.generationProfile,
    pageConcurrency: stage.stage === "write" && stage.writerSlots
      ? stage.writerSlots
      : optionalPositiveNumber(env.DOXA_AGENT_PAGE_CONCURRENCY),
    siteId: context.project.siteId,
    versionId,
    projectSlug: context.project.slug,
    projectName: context.project.name,
    checkoutSpec: resolveGenerationCheckoutSpec(context),
    generatorFingerprint:
      executionConfig.generatorFingerprint,
    planningFingerprint:
      executionConfig.planningFingerprint,
    writingFingerprint:
      executionConfig.writingFingerprint,
    ...(reusableState ? { reusableState } : {}),
    doxabotInstructions: context.doxabotInstructions ?? null,
  };
  const seed = context.seedVersion
    ? await loadSeedSite(
        (key) => readArtifactText(env.DOCS_BUCKET, key),
        context.seedVersion.artifactPrefix,
      )
    : null;
  const seeded = seed ? { ...base, seedSite: seed.site } : base;
  // Each writer gets only its own page; the container selects it by route.
  return stage.stage === "write" && seed
    ? { ...seeded, ...stage, seedBodies: seed.bodies }
    : { ...seeded, ...stage };
}

async function readArtifactText(
  bucket: R2Bucket,
  key: string,
): Promise<string | null> {
  const object = await artifactReader(bucket).get(key);
  return object ? object.text() : null;
}

/**
 * The structure result with page locks applied to its plan: locked pages are
 * kept as published. Later steps read the plan from the stored result, so
 * every step sees the same decision.
 */
function withPageLocks<T extends { plan: IncrementalGenerationPlan }>(
  result: T,
  context: GenerationExecutionContext,
  reusableState: ReusableGenerationState | undefined,
  changes: readonly SourceChange[] | undefined,
  runInstructionsFingerprint: string | undefined,
): T {
  return {
    ...result,
    plan: applyPageLocks({
      plan: result.plan,
      statePages: reusableState?.pages ?? [],
      lockedHrefs: lockedHrefsOf(context),
      changedPaths: changedSourcePaths(changes ?? []),
      instructionsChanged: instructionsChangedSincePublished(
        reusableState,
        runInstructionsFingerprint,
      ),
    }),
  };
}

/**
 * The manifest list of pages behind the instructions. Written only when
 * some are, so most manifests keep the shape that older releases read.
 */
function behindInstructionsField(
  pageStates: readonly GenerationPageState[],
  runFingerprint: string | undefined,
  lockedHrefs: ReadonlySet<string>,
  exhaustedPageIds: ReadonlySet<string>,
): { behindInstructionPageIds?: string[] } {
  if (runFingerprint === undefined) return {};
  const pageIds = behindInstructionPageIds({ pageStates, runFingerprint, lockedHrefs, exhaustedPageIds });
  return pageIds.length > 0 ? { behindInstructionPageIds: pageIds } : {};
}

/** A best-effort step failed; the run goes on without what it would add. */
function logBestEffortStepError(jobId: string, step: string, error: unknown): void {
  console.warn(JSON.stringify({
    service: "doxa-agent-worker",
    eventType: "best_effort_step_failed",
    jobId,
    step,
    message: error instanceof Error ? error.message.slice(0, 500) : "unknown error",
  }));
}

/**
 * True when this run's project instructions differ from the published
 * run's. Unknown, with no baseline or no fingerprint from the stage, is no
 * change, so a lock never flags a page without a reason.
 */
function instructionsChangedSincePublished(
  reusableState: ReusableGenerationState | undefined,
  runInstructionsFingerprint: string | undefined,
): boolean {
  if (!reusableState || runInstructionsFingerprint === undefined) return false;
  const published = reusableState.analysis.projectInstructionsFingerprint ??
    NO_PROJECT_INSTRUCTIONS_FINGERPRINT;
  return published !== runInstructionsFingerprint;
}

async function loadReusableState(
  bucket: R2Bucket,
  context: GenerationExecutionContext,
): Promise<ReusableGenerationState | undefined> {
  const baseline = context.baselineVersion;
  if (!baseline || baseline.id !== context.job.baselineVersionId) {
    return undefined;
  }
  // A reviewed publication names the state of the staged version that the
  // run wrote, so the owner of the state can differ from the baseline.
  const stateVersionId = generationStateOwnerVersionId(
    context.project.siteId,
    baseline.generationStatePrefix,
  );
  if (stateVersionId === null) {
    return undefined;
  }
  const store = new GenerationStateStore(
    createR2GenerationStateStorage(bucket),
  );
  const loaded = await store.load(
    context.project.siteId,
    stateVersionId,
  );
  if (loaded.outcome !== "available") {
    return undefined;
  }
  const [synced, instructionCatchUp] = await Promise.all([
    syncStateWithLiveVersion(bucket, context, loaded.state, {
      liveVersionId: baseline.id,
      generatedVersionId: stateVersionId,
    }),
    readInstructionCatchUpLedger(bucket, context.project.siteId),
  ]);
  return instructionCatchUp ? { ...synced, instructionCatchUp } : synced;
}

/**
 * The stored state brought up to date with the live version, so a run starts
 * from the routes, titles, navigation and pages that people published, not
 * from what the last generation wrote. The version that the state was
 * written with tells which live values a person changed. Every step loads
 * the same versions, so every step sees the same state.
 */
async function syncStateWithLiveVersion(
  bucket: R2Bucket,
  context: GenerationExecutionContext,
  state: ReusableGenerationState,
  versions: { liveVersionId: string; generatedVersionId: string },
): Promise<ReusableGenerationState> {
  const read = (key: string) => readArtifactText(bucket, key);
  const siteId = context.project.siteId;
  const liveArtifactPrefix = buildArtifactPrefix(siteId, versions.liveVersionId);
  const [live, generated] = await Promise.all([
    loadSiteNavigation(read, liveArtifactPrefix, "live version"),
    findSiteNavigation(read, buildArtifactPrefix(siteId, versions.generatedVersionId)),
  ]);
  const synced = await syncReusableStateWithLive({
    state,
    live,
    generated,
    liveArtifactPrefix,
    readers: {
      readLive: (path) => read(`${liveArtifactPrefix}/${path}`),
      readArtifact: read,
      hashContent: sha256Hex,
    },
  });
  return synced.state;
}

async function createPageBatchCacheContext(input: {
  env: Env;
  context: GenerationExecutionContext;
  isPreview: boolean;
  pageIds: readonly string[];
  analysisResult: SuccessfulAnalysisStageResult;
  structureResult: IncrementalStructureStageResult;
  createdAt: string;
}): Promise<PageBatchCacheContext | undefined> {
  if (!isPageCacheEnabled(input.env.DOXA_PAGE_CACHE_ENABLED)) {
    return undefined;
  }

  try {
    const executionConfig = resolveGenerationExecutionConfig(input.context);
    const declaredEvidence = structureSourceEvidenceByPageId(
      input.structureResult.checkpoint,
    );
    const routeRegistryHash = input.structureResult.routeRegistryHash;
    const reusableState = await loadReusableState(
      input.env.DOCS_BUCKET,
      input.context,
    );
    const baselinePages = new Map(
      (reusableState?.pages ?? []).map((page) => [page.pageId, page]),
    );
    const sourceFiles = new Map(
      input.analysisResult.sourceState.files.map((file) => [
        file.path,
        file.contentHash,
      ]),
    );
    // A state without the field comes from a run without instructions.
    const instructionsFingerprint =
      input.analysisResult.analysisState.projectInstructionsFingerprint ??
      NO_PROJECT_INSTRUCTIONS_FINGERPRINT;
    const pageEdits = input.structureResult.plan?.pageEdits ?? {};
    // An edit is keyed by the live text it starts from; see PageCacheKeyInput.
    const editBaseContentHash = (pageId: string): string | null =>
      pageEdits[pageId] ? baselinePages.get(pageId)?.contentHash ?? null : null;
    const descriptors = await Promise.all(input.pageIds.map(
      async (pageId) => {
        const pageInputHash =
          input.structureResult.pageInputHashes[pageId];
        if (!pageInputHash) {
          throw new Error(`Page input hash is missing: ${pageId}`);
        }
        return buildPageCacheDescriptor({
          key: {
            siteId: input.context.project.siteId,
            pageId,
            pageInputHash,
            routeRegistryHash,
            documentationPolicyVersion:
              PUBLIC_DOCUMENTATION_POLICY_VERSION,
            instructionsFingerprint,
            editBaseContentHash: editBaseContentHash(pageId),
          },
          paths: pageDependencyPaths({
            declaredSourceEvidence:
              declaredEvidence.get(pageId) ?? [],
            baselineDependencies:
              baselinePages.get(pageId)?.dependencies,
          }),
          sourceFiles,
          exactWritingContract:
            executionConfig.writingFingerprint,
          crossModelWritingContract: WRITING_CONTRACT_VERSION,
        });
      },
    ));

    return {
      cache: createR2GenerationPageCache(input.env.DOCS_BUCKET),
      descriptors: new Map(
        descriptors.map((descriptor) => [
          descriptor.pageId,
          descriptor,
        ]),
      ),
      allowCrossModel: isCrossModelPageCacheEnabled({
        publicationMode: input.isPreview ? "preview" : "production",
        value: input.env.DOXA_PAGE_CACHE_CROSS_MODEL,
      }),
      writerModel: executionConfig.writerModel,
      writingFingerprint: executionConfig.writingFingerprint,
      createdAt: input.createdAt,
      onCrossModelHit: async (
        pageId,
        cachedWriterModel,
        currentWriterModel,
      ) => {
        await input.env.API.addJobEvent(input.context.job.id, {
          type: "page_cache_cross_model_hit",
          message:
            `Reused cached page ${pageId} from a different writer model.`,
          source: "worker",
          data: {
            pageId,
            cachedWriterModel,
            currentWriterModel,
          },
        }).catch((error: unknown) => {
          logPageCacheError(
            input.context.job.id,
            "event",
            error,
          );
        });
      },
      onCacheError: (operation, error) => {
        logPageCacheError(input.context.job.id, operation, error);
      },
    };
  } catch (error) {
    logPageCacheError(input.context.job.id, "prepare", error);
    return undefined;
  }
}

/**
 * The run-log line that names the instructions version the run follows. The
 * run loads its instructions once, so the line covers every stage and a plan
 * cache hit too. A failed write never stops the run.
 */
export async function recordProjectInstructions(env: Pick<Env, "API">, jobId: string, version: number): Promise<void> {
  await env.API.addJobEvent(jobId, {
    type: PROJECT_INSTRUCTIONS_EVENT_TYPE,
    message: `Following your Doxabot instructions (version ${version}).`,
    source: "worker",
    data: { version },
  }).catch(() => undefined);
}

export const PROJECT_INSTRUCTIONS_EVENT_TYPE = "project_instructions_applied";

export function isPageCacheEnabled(value: string | undefined): boolean {
  return value?.trim() !== "0";
}

/**
 * Records page cache effectiveness for operators.
 *
 * Workers have no filesystem, so this pairs with the container's
 * `.artifacts/generation-performance-logs` NDJSON rather than writing beside
 * it. It stays out of the job event stream because it is diagnostics, not
 * customer-facing generation progress.
 */
export function logPageCacheBatchSummary(input: {
  jobId: string;
  pageCount: number;
  result: PageBatchCacheResult;
  writeStdout?: (line: string) => void;
}): void {
  const { exactHits, crossModelHits, generated, failedPages } = input.result;
  (input.writeStdout ?? console.log)(JSON.stringify({
    service: "doxa-agent-worker",
    eventType: "generation_page_cache_summary",
    jobId: input.jobId,
    pageCount: input.pageCount,
    exactHits,
    crossModelHits,
    generated,
    failed: failedPages.length,
  }));
}

export function isCrossModelPageCacheEnabled(input: {
  publicationMode: "preview" | "production";
  value: string | undefined;
}): boolean {
  return input.publicationMode === "preview" && isTruthyEnvValue(input.value);
}

function isTruthyEnvValue(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function logPageCacheError(
  jobId: string,
  operation: string,
  error: unknown,
): void {
  console.warn(JSON.stringify({
    service: "doxa-agent-worker",
    eventType: "generation_page_cache_error",
    jobId,
    operation,
    error: error instanceof Error ? error.message : String(error),
  }));
}

function requireIncrementalAnalysisResult(
  result: Extract<
    ContainerGenerationStageResult,
    { stage: "analysis"; checkpoint: string }
  >,
): asserts result is SuccessfulAnalysisStageResult {
  if (
    !result.snapshot ||
    !result.sourceState ||
    !result.analysisState ||
    !result.preliminaryPlan ||
    !result.structuralFingerprint
  ) {
    throw new NonRetryableError(
      "Analysis stage omitted revision-aware generation state.",
    );
  }
}

function requireIncrementalStructureResult(
  result: Extract<
    ContainerGenerationStageResult,
    { stage: "structure" }
  >,
): asserts result is IncrementalStructureStageResult {
  if (!result.plan || !result.structureState) {
    throw new NonRetryableError(
      "Structure stage omitted revision-aware generation state.",
    );
  }
}

function requireIncrementalPlanResult(
  result: SuccessfulPlanStageResult,
): asserts result is IncrementalPlanStageResult {
  if (
    !result.snapshot ||
    !result.sourceState ||
    !result.analysisState ||
    !result.structureState ||
    !result.preliminaryPlan ||
    !result.plan ||
    !result.structuralFingerprint
  ) {
    throw new NonRetryableError(
      "Plan stage omitted revision-aware generation state.",
    );
  }
}

function analysisStageResultFromPlan(
  result: IncrementalPlanStageResult,
): SuccessfulAnalysisStageResult {
  return {
    stage: "analysis",
    checkpoint: result.analysisCheckpoint,
    snapshot: result.snapshot,
    sourceState: result.sourceState,
    analysisState: result.analysisState,
    preliminaryPlan: result.preliminaryPlan,
    structuralFingerprint: result.structuralFingerprint,
  };
}

function structureStageResultFromPlan(
  result: IncrementalPlanStageResult,
): IncrementalStructureStageResult {
  return {
    stage: "structure",
    checkpoint: result.structureCheckpoint,
    pageIds: result.pageIds,
    pageInputHashes: result.pageInputHashes,
    routeRegistryHash: result.routeRegistryHash,
    navigation: result.navigation,
    runtimeFeatures: result.runtimeFeatures,
    writerHandoff: result.writerHandoff,
    plan: result.plan,
    structureState: result.structureState,
  };
}

async function readAnalysisStageResult(
  bucket: R2Bucket,
  key: string,
): Promise<SuccessfulAnalysisStageResult> {
  const result = await readStageResult(bucket, key);
  if (result.stage !== "analysis" || !("checkpoint" in result)) {
    throw new NonRetryableError(
      "Stored preview analysis checkpoint is invalid.",
    );
  }
  requireIncrementalAnalysisResult(result);
  return result;
}

async function readStructureStageResult(
  bucket: R2Bucket,
  key: string,
): Promise<IncrementalStructureStageResult> {
  const result = await readStageResult(bucket, key);
  if (result.stage !== "structure") {
    throw new NonRetryableError(
      "Stored preview structure checkpoint is invalid.",
    );
  }
  requireIncrementalStructureResult(result);
  return result;
}

async function readStageResult(
  bucket: R2Bucket,
  key: string,
): Promise<ContainerGenerationStageResult> {
  const raw: unknown = JSON.parse(
    await readCheckpointText(bucket, key),
  );
  const parsed = containerGenerationStageResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new NonRetryableError(
      `Stored generation stage checkpoint is invalid: ${key}`,
    );
  }
  return parsed.data;
}

async function loadReusablePages(
  bucket: R2Bucket,
  context: GenerationExecutionContext,
  reusableState: ReusableGenerationState | undefined,
  plan: IncrementalGenerationPlan,
): Promise<StagedRuntimePage[]> {
  if (plan.reusePageIds.length === 0) {
    return [];
  }
  if (!reusableState || !context.job.baselineVersionId) {
    throw new NonRetryableError(
      "The incremental plan references unavailable baseline pages.",
    );
  }
  const artifactPrefix = buildArtifactPrefix(
    context.project.siteId,
    context.job.baselineVersionId,
  );
  const pageById = new Map(
    reusableState.pages.map((page) => [page.pageId, page]),
  );
  const pages: StagedRuntimePage[] = [];
  for (const pageId of plan.reusePageIds) {
    const state = pageById.get(pageId);
    if (!state) {
      throw new NonRetryableError(
        `Reusable page state is invalid: ${pageId}`,
      );
    }
    pages.push(await materializeReusablePage({
      state,
      siteId: context.project.siteId,
      baselineArtifactPrefix: artifactPrefix,
      async readArtifact(key) {
        const object = await artifactReader(bucket).get(key);
        if (!object || (object.size ?? Infinity) > 5 * 1024 * 1024) {
          return null;
        }
        return object.text();
      },
      hashContent: sha256Hex,
    }));
  }
  return pages;
}

function baselinePageStates(
  reusableState: ReusableGenerationState | undefined,
): Map<string, GenerationPageState> {
  return new Map((reusableState?.pages ?? []).map((page) => [page.pageId, page]));
}

function previewSuccessSummary(
  finalization: GenerationFinalizationCheckpoint,
): string {
  const summary =
    `Doxa updated ${finalization.regeneratedPageCount} page(s), reused ${finalization.reusedPageCount}, and analyzed ${finalization.changedSourceCount} source change(s).`;
  return finalization.flaggedPageCount > 0
    ? `${summary} ${finalization.flaggedPageCount} page(s) could not be written; see the flagged pages in Doxa.`
    : summary;
}

async function readFinalizationCheckpoint(
  bucket: R2Bucket,
  key: string,
): Promise<GenerationFinalizationCheckpoint> {
  const raw: unknown = JSON.parse(
    await readCheckpointText(bucket, key),
  );
  const parsed = finalizationCheckpointSchema.safeParse(raw);
  if (!parsed.success) {
    throw new NonRetryableError(
      "Stored generation finalization checkpoint is invalid.",
    );
  }
  return parsed.data;
}

async function updatePreviewReviewRun(
  env: Env,
  context: GenerationExecutionContext,
  input: {
    state: DoxabotReviewRunState;
    title: string;
    summary: string;
    detailsUrl: string | null;
    metrics?: {
      changedSourceCount?: number;
      regeneratedPageCount?: number;
      reusedPageCount?: number;
    };
  },
): Promise<void> {
  const externalRunId = context.job.externalReviewRunId;
  if (!externalRunId || externalRunId.startsWith("pending:")) {
    return;
  }
  const reviewState = reviewRunState(input.state);
  await env.API.updateReviewRun(context.job.id, {
    externalRunId,
    ...reviewState,
    title: input.title,
    summary: input.summary,
    detailsUrl: input.detailsUrl,
    sourceRevision: requiredTargetRevision(context),
    ...(input.metrics ? { metrics: input.metrics } : {}),
  });
}

function reviewRunState(state: DoxabotReviewRunState):
  | { status: "queued" | "in_progress" }
  | {
      status: "completed";
      conclusion:
        | "success"
        | "failure"
        | "cancelled"
        | "action_required";
    } {
  if (state === "queued" || state === "in_progress") {
    return { status: state };
  }
  return { status: "completed", conclusion: state };
}

function requiredChangeProposal(
  context: GenerationExecutionContext,
): NonNullable<GenerationExecutionContext["changeProposal"]> {
  if (!context.changeProposal) {
    throw new NonRetryableError(
      "Preview change proposal context is missing.",
    );
  }
  return context.changeProposal;
}

function requiredTargetRevision(
  context: GenerationExecutionContext,
): string {
  if (!context.job.targetRevision) {
    throw new NonRetryableError(
      "Preview target revision is missing.",
    );
  }
  return context.job.targetRevision;
}

function requiredGeneratorFingerprint(
  context: GenerationExecutionContext,
): string {
  if (!context.job.generatorFingerprint) {
    throw new NonRetryableError(
      "Preview generator fingerprint is missing.",
    );
  }
  return context.job.generatorFingerprint;
}

function requiredSourceProvider(
  context: GenerationExecutionContext,
): SourceProvider {
  if (!context.job.sourceProvider) {
    throw new NonRetryableError(
      "Preview source provider is missing.",
    );
  }
  return context.job.sourceProvider;
}

async function createStageRequest(
  env: Env,
  input: GenerateJobMessage,
  prepared: PreparedGeneration,
  stage:
    | { stage: "analysis" }
    | { stage: "plan" }
    | { stage: "structure"; analysisCheckpoint: string }
    | {
        stage: "write";
        analysisCheckpoint: string;
        structureCheckpoint: string;
        writerHandoff?: WriterHandoffManifest;
        pageIds: string[];
      },
): Promise<ContainerGenerationStageRequest> {
  const installationAccessToken = await env.API.createRepositoryReadToken(
    prepared.context.project.id,
  );
  const legacyModel = env.DOXA_AGENT_MODEL?.trim();
  const plannerModel =
    env.DOXA_PLANNER_MODEL?.trim() ||
    legacyModel ||
    DEFAULT_DOXA_PLANNER_MODEL;
  const writerModel =
    env.DOXA_WRITER_MODEL?.trim() ||
    legacyModel ||
    DEFAULT_DOXA_WRITER_MODEL;
  const models = resolveGenerationModels(env, { plannerModel, writerModel });
  const base: ContainerGenerateRequest = {
    jobId: input.jobId,
    repositoryFullName: prepared.context.repository.fullName,
    defaultBranch: prepared.context.repository.defaultBranch,
    installationAccessToken,
    ...(await resolveStageModelAuth(env, env.API, generationModelIds(models))),
    model: stage.stage === "write" ? writerModel : plannerModel,
    modelConfig: models,
    stageExecutionId: crypto.randomUUID(),
    generationProfile: env.DOXA_GENERATION_PROFILE ?? "fast-mvp",
    pageConcurrency: optionalPositiveNumber(env.DOXA_AGENT_PAGE_CONCURRENCY),
    siteId: prepared.context.project.siteId,
    versionId: prepared.versionId,
    projectSlug: prepared.context.project.slug,
    projectName: prepared.context.project.name,
    doxabotInstructions: prepared.context.doxabotInstructions ?? null,
  };
  return { ...base, ...stage };
}

/**
 * Reuses the plan of an earlier run with the same plan inputs: the exact
 * revision, the baseline or seed, the models and the settings. The run then
 * goes straight to writing.
 */
async function invokePlanStageWithCache(
  env: Env,
  request: ContainerGenerationStageRequest,
  createdAt: string,
): Promise<ContainerGenerationStageResult> {
  if (!isPlanCacheEnabled(env.DOXA_PLAN_CACHE_ENABLED)) {
    return invokeStage(env, request);
  }
  const cache = createR2GenerationPlanCache(env.DOCS_BUCKET);
  const key = await planCacheKey(request);
  const cached = await cache.get(key);
  if (cached) {
    await env.API.addJobEvent(request.jobId, {
      type: "plan_cache_hit",
      message: "Reused the plan of an earlier run of the same source revision and settings.",
      source: "worker",
      data: { pageCount: cached.pageIds.length },
    }).catch(() => undefined);
    return cached;
  }
  const result = await invokeStage(env, request);
  if (isCachedPlanResult(result)) await cache.put(key, result, createdAt);
  return result;
}

export function isPlanCacheEnabled(value: string | undefined): boolean {
  return value?.trim() !== "0";
}

async function invokeStage(
  env: Env,
  request: ContainerGenerationStageRequest,
  callbacks: {
    onPageCheckpoint?: (page: StagedRuntimePage) => Promise<void>;
  } = {},
): Promise<ContainerGenerationStageResult> {
  const secrets = [request.installationAccessToken, request.modelApiKey, request.modelAuthToken]
    .filter((secret): secret is string => secret !== undefined);
  let status = "completed";
  const usageRecords = new Map<string, Parameters<typeof persistGenerationUsage>[1]>();
  try {
    return await callGenerationStage(request, {
      agentContainerBinding: env.AGENT_CONTAINER,
      agentContainerUrl: env.AGENT_CONTAINER_URL,
      idleTimeoutMs: positiveNumber(env.GENERATION_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS),
    }, {
      onHeartbeat: async () => ensureJobActive(env, request.jobId),
      onEvent: async (event) => {
        await ensureJobActive(env, request.jobId);
        await forwardGenerationStageEvent({
          jobId: request.jobId,
          stage: request.stage,
          event,
          secrets,
          persist: (sanitized) =>
            env.API.addJobEvent(request.jobId, sanitized),
        });
      },
      onUsage: async (record) => {
        await persistGenerationUsage(env, record);
        usageRecords.set(record.callId, record);
      },
      onDiagnostic: (diagnostic) =>
        persistGenerationDiagnostic(env, diagnostic),
      onPageCheckpoint: callbacks.onPageCheckpoint,
    });
  } catch (error) {
    status = usageFailureStatus(error);
    const message = sanitizeErrorMessage(
      error instanceof Error ? error.message : "Generation stage failed.",
      secrets,
    );
    const retryable = error instanceof GenerationStageRequestError
      ? error.retryable
      : !(error instanceof NonRetryableError);
    const code = error instanceof GenerationStageRequestError
      ? error.code
      : error instanceof NonRetryableError
        ? "workflow_non_retryable"
        : "generation_stage_transport_failed";
    console.error(JSON.stringify({
      service: "doxa-agent-worker",
      eventType: "generation_stage_failed",
      jobId: request.jobId,
      stage: request.stage,
      retryable,
      code,
      error: message,
    }));

    if (status === "failed") {
      await forwardGenerationStageFailure({
        jobId: request.jobId,
        stage: request.stage,
        errorMessage: message,
        retryable,
        code,
        secrets,
        persist: (event) => env.API.addJobEvent(request.jobId, event),
      });
    }

    if (error instanceof NonRetryableError) throw error;
    if (error instanceof GenerationStageRequestError && !error.retryable) {
      throw new NonRetryableError(message);
    }
    throw new Error(message);
  } finally {
    logGenerationUsageSummary(
      summarizeGenerationUsageRecords(
        request.jobId,
        [...usageRecords.values()],
      ),
      { stage: request.stage, status },
    );
  }
}

function usageFailureStatus(error: unknown): "failed" | "cancelled" {
  const message = error instanceof Error ? error.message : String(error);
  return /generation job is no longer active|generation is paused/i.test(message)
    ? "cancelled"
    : "failed";
}

export function assertGenerationDatabaseCompatible(
  compatibility: GenerationDatabaseCompatibility,
): void {
  if (compatibility.ready) return;
  const missingColumns = [...compatibility.missingColumns].sort();
  throw new NonRetryableError(
    `Generation database schema is incompatible; missing columns: ${missingColumns.join(", ")}.`,
  );
}

async function logUsageSummarySafely(
  env: Env,
  jobId: string,
  status: string,
  stage?: string,
): Promise<void> {
  try {
    await logPersistedGenerationUsageSummary(env, jobId, {
      ...(stage ? { stage } : {}),
      status,
    });
  } catch (error) {
    console.error(JSON.stringify({
      service: "doxa-agent-worker",
      eventType: "generation_usage_summary_failed",
      jobId,
      stage: stage ?? null,
      status,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function ensureJobActive(env: Env, jobId: string): Promise<void> {
  if (!(await env.API.isJobActive(jobId))) {
    throw new NonRetryableError("Generation job is no longer active.");
  }
}

function ensureWithinOverallBudget(startedAt: Date, timeoutMs: number): void {
  if (Date.now() - startedAt.getTime() > timeoutMs) {
    throw new NonRetryableError(`Generation exceeded its ${Math.ceil(timeoutMs / 60_000)}-minute overall budget.`);
  }
}

function assertWritingStageFeasible(input: {
  event: Pick<GenerationWorkflowEvent<unknown>, "timestamp">;
  overallTimeoutMs: number;
  budget: WritingStageBudgetInput;
  finalizationTimeoutMs: number;
}): void {
  const feasibility = assessGenerationFeasibility({
    ...input.budget,
    elapsedMs: Math.max(
      0,
      Date.now() - input.event.timestamp.getTime(),
    ),
    overallTimeoutMs: input.overallTimeoutMs,
    finalizationTimeoutMs: input.finalizationTimeoutMs,
  });
  if (feasibility.feasible) return;

  throw new NonRetryableError(
    `Generation cannot fit ${feasibility.batchCount} write batches and finalization ` +
      `inside the remaining ${feasibility.remainingMs}ms overall budget.`,
  );
}

/** The config of a best-effort step: bounded like any step, but never retried. */
function bestEffortStepConfig(startedAt: Date, overallTimeoutMs: number, stageTimeoutMs: number) {
  return { ...boundedStepConfig(startedAt, overallTimeoutMs, stageTimeoutMs), retries: NO_STEP_RETRIES };
}

function boundedStepConfig(startedAt: Date, overallTimeoutMs: number, stageTimeoutMs: number) {
  const remainingMs = Math.max(1, overallTimeoutMs - (Date.now() - startedAt.getTime()));
  return {
    retries: { limit: 2, delay: "1 minute" as const, backoff: "exponential" as const },
    timeout: Math.min(stageTimeoutMs, remainingMs),
  };
}

/**
 * Pages per write group, one Workflow step each. A group exists for
 * durability: a failed step resumes only its unfinished pages. Writers are
 * scheduled by the container's shared limiter, not by the group, so a group
 * of one writer ceiling keeps the steps few without a barrier per batch.
 */
export const DEFAULT_WRITE_GROUP_SIZE = 24;

export function resolveWriteGroupSize(value: string | undefined): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_WRITE_GROUP_SIZE;
  return Math.min(parsed, MAX_WRITE_GROUP_PAGES);
}

/**
 * A run that a person continued gets a fresh time budget from that moment;
 * otherwise the budget of a run that failed yesterday would be spent at once.
 * The workflow reads it on every replay, outside any step, so a restart sees
 * the new time while the steps before it keep their results.
 */
export async function withResumedBudgetStart(
  env: Pick<Env, "API">,
  event: Readonly<GenerationWorkflowEvent<GenerateJobMessage>>,
): Promise<Readonly<GenerationWorkflowEvent<GenerateJobMessage>>> {
  let resumedAt: string | null;
  try {
    resumedAt = await env.API.getGenerationResumedAt(event.payload.jobId);
  } catch {
    return event;
  }
  const resumed = resumedAt ? new Date(resumedAt) : null;
  return resumed && resumed.getTime() > event.timestamp.getTime()
    ? { ...event, timestamp: resumed }
    : event;
}

/** Writers one job may run at once, when DOXA_AGENT_PAGE_CONCURRENCY is not set. */
const DEFAULT_JOB_WRITER_CEILING = 24;

/** A lease outlives its write group a little, so a slow step keeps its slots. */
const WRITER_SLOT_TTL_MARGIN_MS = 60_000;

/** The lease of a template group, which holds no writer slot. */
const NO_WRITER_SLOT_LEASE = { leaseId: null, granted: 0 } as const;

function resolveWriteGroupTimeouts(env: Env): WriteGroupTimeouts {
  return {
    model: positiveNumber(env.PAGE_BATCH_TIMEOUT_MS, DEFAULT_PAGE_BATCH_TIMEOUT_MS),
    template: positiveNumber(
      env.TEMPLATE_PAGE_BATCH_TIMEOUT_MS,
      DEFAULT_TEMPLATE_PAGE_BATCH_TIMEOUT_MS,
    ),
  };
}

/**
 * The job's writer slots. The limiter only shares capacity between jobs, so
 * when it cannot answer, the group runs at the job ceiling instead of failing.
 */
export async function acquireWriterSlots(
  limiter: WriterSlotLimiter,
  input: { jobId: string; requested: number; ttlMs: number },
): Promise<{ leaseId: string | null; granted: number }> {
  try {
    return await limiter.acquire({
      ...input,
      minimum: 1,
      ttlMs: Math.min(input.ttlMs, MAX_WRITER_SLOT_TTL_MS),
    });
  } catch (error) {
    console.warn(JSON.stringify({
      service: "doxa-agent-worker",
      eventType: "writer_slots_unavailable",
      jobId: input.jobId,
      error: error instanceof Error ? error.message : String(error),
    }));
    return { leaseId: null, granted: input.requested };
  }
}

/**
 * Frees the job's writer slots after its write groups. A failed or stopped
 * run frees them when the lease expires.
 */
export async function releaseWriterSlotLeases(
  limiter: WriterSlotLimiter,
  batches: readonly SettledBatch<{ writerSlotLeaseId: string | null }>[],
): Promise<void> {
  const leaseIds = new Set(batches.flatMap((batch) =>
    batch.status === "fulfilled" && batch.value.writerSlotLeaseId
      ? [batch.value.writerSlotLeaseId]
      : []
  ));
  for (const leaseId of leaseIds) {
    await limiter.release(leaseId).catch(() => undefined);
  }
}

export function resolveWriteBatchParallelism(value: string | undefined): number {
  if (!value?.trim()) return 2;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(4, Math.max(1, Math.trunc(parsed)));
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function combinedPlanningTimeoutMs(
  env: Pick<Env, "ANALYSIS_STAGE_TIMEOUT_MS" | "STRUCTURE_STAGE_TIMEOUT_MS">,
): number {
  return positiveNumber(
    env.ANALYSIS_STAGE_TIMEOUT_MS,
    DEFAULT_ANALYSIS_TIMEOUT_MS,
  ) + positiveNumber(
    env.STRUCTURE_STAGE_TIMEOUT_MS,
    DEFAULT_STRUCTURE_TIMEOUT_MS,
  );
}

function optionalPositiveNumber(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function emitArtifactLinkWarnings(
  env: Pick<Env, "API">,
  jobId: string,
  files: readonly ContainerArtifactFile[],
  navigation: RuntimeDocsNavigation,
): Promise<void> {
  try {
    const warnings = validateArtifactLinks(files, navigation);
    await Promise.all(warnings.map((warning) =>
      env.API.addJobEvent(jobId, {
        type: "artifact_link_warning",
        message:
          `Generated page ${warning.page} links to a route absent from final navigation: ${warning.route}.`,
        source: "worker",
        data: {
          page: warning.page,
          route: warning.route,
        },
      }).catch(() => undefined)
    ));
  } catch {
    // Link inspection is diagnostic-only and must never block publication.
  }
}

export function finalizeRuntimeNavigation(
  navigation: RuntimeDocsNavigation,
  pages: readonly Pick<StagedRuntimePage, "navigationPath">[],
): RuntimeDocsNavigation {
  const availablePaths = new Set(
    pages.map((page) => page.navigationPath),
  );
  const sections = navigation.sections
    .map((section) => {
      const items = section.items.filter((path) =>
        availablePaths.has(path),
      );
      const groups = section.groups
        ?.map((group) => ({
          ...group,
          items: group.items.filter((path) =>
            availablePaths.has(path),
          ),
        }))
        .filter((group) => group.items.length > 0);
      return {
        ...section,
        items,
        ...(groups ? { groups } : {}),
      };
    })
    .filter((section) => section.items.length > 0);
  const sectionSlugs = new Set(sections.map((section) => section.slug));

  return {
    sections,
    ...(navigation.icons
      ? { icons: filterNavigationRecord(navigation.icons, availablePaths) }
      : {}),
    ...(navigation.navTitles
      ? {
          navTitles: filterNavigationRecord(
            navigation.navTitles,
            availablePaths,
          ),
        }
      : {}),
    ...(navigation.navBadges
      ? {
          navBadges: filterNavigationRecord(
            navigation.navBadges,
            availablePaths,
          ),
        }
      : {}),
    ...(navigation.sectionMetadata
      ? {
          sectionMetadata: filterNavigationRecord(
            navigation.sectionMetadata,
            sectionSlugs,
          ),
        }
      : {}),
  };
}

function filterNavigationRecord<T>(
  record: Record<string, T>,
  allowedKeys: ReadonlySet<string>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => allowedKeys.has(key)),
  );
}

async function readCheckpointText(bucket: R2Bucket, key: string): Promise<string> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`Generation checkpoint is missing: ${key}`);
  return object.text();
}

async function readStructureCheckpoint(bucket: R2Bucket, key: string): Promise<StructureCheckpoint> {
  const raw: unknown = JSON.parse(
    await readCheckpointText(bucket, key),
  );
  const parsed = z.object({
    structureCheckpoint: z.string().min(2),
    pageIds: z.array(z.string().min(1)).min(1),
    navigation: runtimeDocsNavigationSchema,
    runtimeFeatures: runtimeDocsFeaturesSchema.optional(),
    writerHandoff: writerHandoffManifestSchema.optional(),
  }).safeParse(raw);
  if (!parsed.success) throw new NonRetryableError("Stored structure checkpoint is invalid.");
  return parsed.data;
}

async function readPageCheckpoint(bucket: R2Bucket, key: string): Promise<StagedRuntimePage[]> {
  const raw: unknown = JSON.parse(
    await readCheckpointText(bucket, key),
  );
  try {
    return parseGenerationPageCheckpoint(raw);
  } catch {
    throw new NonRetryableError(`Stored page checkpoint is invalid: ${key}`);
  }
}

async function deleteCheckpointPrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    if (listed.objects.length > 0) await bucket.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
