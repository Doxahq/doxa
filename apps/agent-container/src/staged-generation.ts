import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { relative } from "node:path";
import {
  analyzeProjectOnly,
  acquireSharedMdxValidatorPool,
  buildDeterministicNavOrderManifest,
  buildPageInputHashMap,
  buildRouteRegistry,
  buildWriterHandoff,
  documentationBriefFingerprint,
  flattenStructure,
  generateDocumentation,
  keepPublishedRoutes,
  normalizeProjectAnalysis,
  PUBLIC_DOCUMENTATION_POLICY_VERSION,
  resolveRestApiRuntimeFeatures,
  reviewDocumentationStructure,
  releaseSharedMdxValidatorPool,
  selectWriterPageBriefs,
  sourceChangePaths,
  stablePageId,
  suggestStructure,
  validateGlobalPageIds,
  type AgentConfig,
  type AgentSpanCallback,
  type AgentUsageRecord,
  type AgentProgressEvent,
  type DocumentationStructure,
  type GeneratedPageContent,
  type PageGenerationFailure,
  type ProjectAnalysis,
  type Provider,
  type SpecReaderClient,
  type StructureReviewDecisionSummary,
  type WriterDiagnosticCallback,
  type WriterRepairDiagnostic,
  seedTextForPages,
} from "@doxahq/agent";
import {
  GENERATION_DIAGNOSTIC_DRAFT_MAX_CHARS,
  truncateGenerationDiagnosticDraft,
  type ContainerGenerationStageRequest,
  type ContainerGenerationStageResult,
  type FailedStagePage,
  type GenerationRepairDiagnostic,
  type GenerationUsageRecord,
  type RuntimeDocsNavigation,
  type StagedRuntimePage,
} from "@doxahq/contracts";
import { normalizeHref } from "@doxahq/docs-engine";
import { assertGitAvailable, cloneRepository } from "./git";
import {
  ensureRepositorySnapshot,
  type PreparedRepositorySnapshotResult,
} from "./repository-snapshot";
import { captureGenerationSourceState } from "./source-state";
import {
  analyzeIncrementalGeneration,
  finalizeIncrementalPlan,
  seedStructure,
  reusableStructure,
} from "./incremental-generation";
import { resolveSnapshotSourceDelta } from "./source-delta";
import {
  applyGenerationProfileBudget,
  countStructurePages,
  HOSTED_DOCS_QUALITY,
  HOSTED_WRITER_EXPLORATION,
  HOSTED_WRITER_MAX_STEPS,
  HOSTED_WRITER_VALIDATION,
  HOSTED_PAGE_FAILURE_MAX_RETRIES,
  hostedDocsQualityFailureAction,
  hostedPageFailureAction,
  resolvedEditorialPageBudget,
  resolvedPageConcurrency,
} from "./generation-profile";
import { HOSTED_AGENT_TOOL_POLICY } from "./worker-core";
import { createWriterDiagnosticLogger, outputSecrets } from "./logging";
import { GenerationStageInvariantError } from "./generation-stage-errors";
import { releaseWriterLimiter, throttleOnRetry, writerLimiterForJob } from "./writer-width";
import {
  createHostedWorkspaceLayout,
  resolveHostedWorkspaceBaseDir,
  type HostedWorkspaceLayout,
} from "./workspace-layout";
import { createStageTimings } from "./stage-timings";
import {
  recordGenerationPerformance,
  type GenerationPerformanceRecord,
} from "./performance-log";
import { stripUnsupportedMdxEsm } from "./runtime-page-content";
import { resolveRunBrief } from "./run-brief";
import { hostedRepoMapOptions } from "./repo-map";
import { patchPublishedStructure } from "./structure-patch";
import { resolveSpecReaderClient } from "./utility/spec-reader-client";
import { assertWriteGroupSize } from "./write-group-size";
import { referenceSourceLogEvent } from "./reference-source-event";

export type StageEventEmitter = (
  type: string,
  message: string,
  data?: Record<string, unknown>,
) => Promise<void>;

export interface StageObservability {
  onUsage?: (record: GenerationUsageRecord) => Promise<void> | void;
  onDiagnostic?: (
    diagnostic: GenerationRepairDiagnostic,
  ) => Promise<void> | void;
  onPageCheckpoint?: (
    page: StagedRuntimePage,
  ) => Promise<void> | void;
}

export interface GenerationStageRuntime {
  workspaceBaseDir?: string;
  repositoryUrl?: string;
  createProvider?: (
    input: ContainerGenerationStageRequest,
  ) => Provider;
  onWriterDiagnostic?: WriterDiagnosticCallback;
  prepareWorkspace?: (
    input: ContainerGenerationStageRequest,
    emitEvent: StageEventEmitter,
    abortController: AbortController,
    workspace: HostedWorkspaceLayout,
  ) => Promise<PreparedRepositorySnapshotResult | null>;
  /** Overrides where stage performance samples are written. */
  recordPerformance?: (
    record: GenerationPerformanceRecord,
  ) => Promise<void>;
  /** Overrides the spec-reader client of a run; tests use a fake. */
  createSpecReader?: (runId: string) => SpecReaderClient | undefined;
}

export async function runGenerationStage(
  input: ContainerGenerationStageRequest,
  emitEvent: StageEventEmitter,
  abortController: AbortController,
  observability: StageObservability = {},
  runtime: GenerationStageRuntime = {},
): Promise<ContainerGenerationStageResult> {
  const stageExecutionId = input.stageExecutionId ?? crypto.randomUUID();
  const stageTimings = createStageTimings(input.stage);
  const workspace = createHostedWorkspaceLayout(
    runtime.workspaceBaseDir ?? resolveHostedWorkspaceBaseDir(),
    input.jobId,
    `${input.stage}-${stageExecutionId}`,
  );
  acquireSharedMdxValidatorPool();
  try {
    const snapshotStartedAt = Date.now();
    let preparedSnapshot: PreparedRepositorySnapshotResult | null;
    try {
      preparedSnapshot = runtime.prepareWorkspace
        ? await runtime.prepareWorkspace(
            input,
            emitEvent,
            abortController,
            workspace,
          )
        : await prepareWorkspace(
            input,
            emitEvent,
            abortController,
            workspace,
            runtime,
          );
    } finally {
      stageTimings.markSnapshot(Date.now() - snapshotStartedAt);
    }
    if (preparedSnapshot?.outcome === "merge_conflict") {
      return input.stage === "plan"
        ? {
            stage: "plan",
            outcome: "merge_conflict",
            targetRevision: preparedSnapshot.targetRevision,
            message: preparedSnapshot.message,
          }
        : {
            stage: "analysis",
            outcome: "merge_conflict",
            targetRevision: preparedSnapshot.targetRevision,
            message: preparedSnapshot.message,
          };
    }
    const config = createAgentConfig(
      input,
      abortController,
      workspace,
      observability,
      runtime,
      stageTimings.onSpan,
      ({ mode }) => stageTimings.markWriterExploration(mode),
      stageExecutionId,
    );
    const onProgress = (event: AgentProgressEvent) => {
      const type = event.stage === "analyzing"
        ? "analysis_progress"
        : event.stage === "writing"
          ? "page_write_completed"
          : "stage_progress";
      void emitEvent(type, event.message, {
        stage: event.stage,
        progress: event.progress,
        currentItem: event.currentItem,
      });
    };

    // `return await` keeps the `finally` below (performance sample, stage
    // cleanup) after the stage settles, not when its promise is returned.
    if (input.stage === "analysis") {
      return await executeAnalysisStage({
        input,
        config,
        preparedSnapshot,
        onProgress,
        emitEvent,
      });
    }

    if (input.stage === "plan") {
      const analysisResult = await executeAnalysisStage({
        input,
        config,
        preparedSnapshot,
        onProgress,
        emitEvent,
      });
      const structureResult = await executeStructureStage({
        input,
        config,
        preparedSnapshot,
        onProgress,
        emitEvent,
        analysisCheckpoint: analysisResult.checkpoint,
        sourceState: analysisResult.sourceState,
        preliminaryPlan: analysisResult.preliminaryPlan,
        structuralFingerprint: analysisResult.structuralFingerprint,
      });
      return {
        stage: "plan",
        analysisCheckpoint: analysisResult.checkpoint,
        structureCheckpoint: structureResult.checkpoint,
        pageIds: structureResult.pageIds,
        pageInputHashes: structureResult.pageInputHashes,
        routeRegistryHash: structureResult.routeRegistryHash,
        navigation: structureResult.navigation,
        runtimeFeatures: structureResult.runtimeFeatures,
        writerHandoff: structureResult.writerHandoff,
        snapshot: analysisResult.snapshot,
        sourceState: analysisResult.sourceState,
        analysisState: analysisResult.analysisState,
        preliminaryPlan: analysisResult.preliminaryPlan,
        structuralFingerprint: analysisResult.structuralFingerprint,
        plan: structureResult.plan,
        structureState: structureResult.structureState,
      };
    }

    if (input.stage === "structure") {
      return await executeStructureStage({
        input,
        config,
        preparedSnapshot,
        onProgress,
        emitEvent,
        analysisCheckpoint: input.analysisCheckpoint,
        sourceState: input.sourceState,
        preliminaryPlan: input.preliminaryPlan,
        structuralFingerprint: input.structuralFingerprint,
      });
    }

    const analysis = normalizeProjectAnalysis(
      parseCheckpoint(input.analysisCheckpoint, "analysis"),
    );
    const structure = parseStructureCheckpoint(input.structureCheckpoint);
    assertWriteGroupSize(structure, input.pageIds);
    await emitEvent("writing_started", `Writing ${input.pageIds.length} documentation page(s).`, {
      pageCount: input.pageIds.length,
      pageConcurrency: resolvedPageConcurrency(input),
    });
    const generation = await generateDocumentation(
      config,
      structure,
      onProgress,
      {
        analysis,
        answers: {},
        structure,
        documentationBrief: config.documentationBrief,
        ...(input.writerHandoff
          ? {
              writerHandoff: selectWriterPageBriefs(
                input.writerHandoff,
                input.pageIds,
              ),
            }
          : {}),
        ...(input.seedBodies
          ? {
              seedPages: seedTextForPages(
                structure,
                input.pageIds,
                new Map(Object.entries(input.seedBodies)),
              ),
            }
          : {}),
        // Published pages that the run edits instead of writing again.
        ...(input.previousPages ? { previousPages: input.previousPages } : {}),
      },
      undefined,
      undefined,
      { pageIds: input.pageIds, finalize: false },
    );
    const pages = generation.pages.map((page) =>
      toStagedRuntimePage(page, generation.outputDir)
    );
    const failedPages = toFailedStagePages(generation.skippedPages);
    if (pages.length + failedPages.length !== input.pageIds.length) {
      throw new GenerationStageInvariantError(
        `Write stage produced ${pages.length} pages and ${failedPages.length} failed pages for a ${input.pageIds.length}-page checkpoint batch.`,
        "write_checkpoint_page_count_mismatch",
      );
    }
    await emitEvent("pages_written", `${pages.length} documentation page(s) checkpointed.`, {
      pageCount: pages.length,
      failedPageCount: failedPages.length,
    });
    for (const failed of failedPages) {
      await emitEvent("page_write_failed", `${failed.title} could not be written: ${failed.reason}`, {
        pageId: failed.id,
        title: failed.title,
        reason: failed.reason,
      });
    }
    return { stage: "write", pages, failedPages };
  } finally {
    releaseWriterLimiter(input.jobId);
    // TanStack may deliver its final async observability callbacks as the
    // stream closes. Yield once so the recorded summary includes them.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await recordStagePerformanceSafely(runtime, {
      jobId: input.jobId,
      stageExecutionId,
      recordedAt: new Date().toISOString(),
      summary: stageTimings.summarize(),
    });
    await releaseSharedMdxValidatorPool();
    await rm(workspace.stageRoot, { recursive: true, force: true });
  }
}

/**
 * Records a stage performance sample without letting diagnostics mask the
 * stage's own outcome.
 */
async function recordStagePerformanceSafely(
  runtime: GenerationStageRuntime,
  record: GenerationPerformanceRecord,
): Promise<void> {
  try {
    await (runtime.recordPerformance ?? recordGenerationPerformance)(record);
  } catch (error) {
    console.error(JSON.stringify({
      service: "doxa-agent-container",
      eventType: "generation_performance_record_failed",
      jobId: record.jobId,
      stage: record.summary.stage,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

type SuccessfulAnalysisStageResult = Extract<
  ContainerGenerationStageResult,
  { stage: "analysis"; checkpoint: string }
>;

type SuccessfulStructureStageResult = Extract<
  ContainerGenerationStageResult,
  { stage: "structure" }
>;

interface AnalysisStageExecution {
  input: ContainerGenerationStageRequest;
  config: AgentConfig;
  preparedSnapshot: PreparedRepositorySnapshotResult | null;
  onProgress: (event: AgentProgressEvent) => void;
  emitEvent: StageEventEmitter;
}

const DEFAULT_PLANNING_FINGERPRINT = "doxa-planning-contract-v2";

async function executeAnalysisStage(
  execution: AnalysisStageExecution,
): Promise<SuccessfulAnalysisStageResult> {
  const {
    input,
    preparedSnapshot,
    onProgress,
    emitEvent,
  } = execution;
  const config: AgentConfig = {
    ...execution.config,
    repoMap: hostedRepoMapOptions({
      sourceTreeHash: preparedSnapshot?.outcome === "prepared"
        ? preparedSnapshot.snapshot.sourceTreeHash
        : undefined,
      emitEvent,
    }),
  };
  await emitEvent("analysis_started", "Analyzing repository.");
  if (preparedSnapshot?.outcome === "prepared") {
    const sourceState = await captureGenerationSourceState(
      preparedSnapshot.checkoutPath,
      preparedSnapshot.snapshot,
    );
    const snapshot = resolveSnapshotSourceDelta({
      snapshot: preparedSnapshot.snapshot,
      current: sourceState,
      previous: input.reusableState?.source,
    });
    const incremental = await analyzeIncrementalGeneration({
      config,
      planningFingerprint:
        input.planningFingerprint ?? DEFAULT_PLANNING_FINGERPRINT,
      writingFingerprint:
        input.writingFingerprint ?? "doxa-writing-contract-v1",
      onProgress,
      reusableState: input.reusableState,
      snapshot,
      sourceState,
    });
    await emitEvent(
      "analysis_complete",
      "Revision-aware repository analysis checkpoint created.",
      {
        analysisMode: incremental.preliminaryPlan.analysisMode,
        structureMode: incremental.preliminaryPlan.structureMode,
        modelCallsRequired:
          incremental.preliminaryPlan.modelCallsRequired,
        reason: incremental.preliminaryPlan.reasons[0],
        ...referenceSourceEventData(incremental.analysis),
      },
    );
    await emitReferenceSourceLine(emitEvent, incremental.analysis);
    return {
      stage: "analysis",
      checkpoint: JSON.stringify(incremental.analysis),
      snapshot,
      sourceState,
      analysisState: incremental.analysisState,
      preliminaryPlan: incremental.preliminaryPlan,
      structuralFingerprint: incremental.structuralFingerprint,
    };
  }

  const analysis = await analyzeProjectOnly(config, onProgress);
  await emitEvent(
    "analysis_complete",
    "Repository analysis checkpoint created.",
    referenceSourceEventData(analysis),
  );
  await emitReferenceSourceLine(emitEvent, analysis);
  return {
    stage: "analysis",
    checkpoint: JSON.stringify(analysis),
  };
}

/**
 * Where the REST reference came from, for the analysis event: a status,
 * spec paths, codes and counts. It never holds spec text.
 */
function referenceSourceEventData(analysis: ProjectAnalysis): Record<string, unknown> {
  const report = analysis.referenceSourceReport;
  return report ? { referenceSource: report } : {};
}

/** The log line that says where the REST reference came from; none without a report. */
async function emitReferenceSourceLine(
  emitEvent: StageEventEmitter,
  analysis: ProjectAnalysis,
): Promise<void> {
  const report = analysis.referenceSourceReport;
  if (!report) return;
  const line = referenceSourceLogEvent(report);
  await emitEvent(line.type, line.message, { ...line.data });
}

interface StructureStageExecution extends AnalysisStageExecution {
  analysisCheckpoint: string;
  sourceState?: SuccessfulAnalysisStageResult["sourceState"];
  preliminaryPlan?: SuccessfulAnalysisStageResult["preliminaryPlan"];
  structuralFingerprint?:
    SuccessfulAnalysisStageResult["structuralFingerprint"];
}

async function executeStructureStage(
  execution: StructureStageExecution,
): Promise<SuccessfulStructureStageResult> {
  const {
    input,
    config,
    preparedSnapshot,
    onProgress,
    emitEvent,
    analysisCheckpoint,
    sourceState,
    preliminaryPlan,
    structuralFingerprint,
  } = execution;
  const analysis = normalizeProjectAnalysis(
    parseCheckpoint(analysisCheckpoint, "analysis"),
  );
  const editorialPageBudget = resolvedEditorialPageBudget(input);
  const baselineStructure = reusableStructure(input.reusableState);
  const reusablePublishedStructure = preliminaryPlan?.structureMode === "reuse"
    ? baselineStructure
    : null;
  // A route or schema change keeps the published structure and rebuilds its
  // reference sections from the new analysis, with no planner call. Without
  // a readable published structure, the run plans it again instead.
  const patchablePublishedStructure = preliminaryPlan?.structureMode === "patch"
    ? baselineStructure
    : null;
  const structurePlan = preliminaryPlan?.structureMode === "patch" && !patchablePublishedStructure
    ? { ...preliminaryPlan, structureMode: "regenerate" as const }
    : preliminaryPlan;
  // Without a generation baseline, a seeded run anchors the plan to the
  // structure of the hand-written site instead.
  const regenerationAnchor = structurePlan?.structureMode === "regenerate"
    ? (baselineStructure ?? seedStructure(input.seedSite))
    : null;
  const snapshotWithDelta =
    preparedSnapshot?.outcome === "prepared" && sourceState
      ? resolveSnapshotSourceDelta({
          snapshot: preparedSnapshot.snapshot,
          current: sourceState,
          previous: input.reusableState?.source,
        })
      : null;
  const changedSourcePaths = snapshotWithDelta
    ? sourceChangePaths(snapshotWithDelta.changes)
    : [];
  let reviewDecisionSummary: StructureReviewDecisionSummary | undefined;
  let reviewDegraded = false;
  let structure: DocumentationStructure;

  if (reusablePublishedStructure) {
    structure = reusablePublishedStructure;
    await emitEvent(
      "structure_reused",
      "Reusing the compatible published documentation structure.",
      { pageCount: countStructurePages(structure) },
    );
  } else if (patchablePublishedStructure) {
    const patch = patchPublishedStructure(
      patchablePublishedStructure,
      analysis,
      input.reusableState ? normalizeProjectAnalysis(input.reusableState.analysis.analysis) : undefined,
    );
    structure = patch.structure;
    await emitEvent(
      "structure_patched",
      "Patched the published documentation structure with the new reference pages.",
      {
        pageCount: countStructurePages(structure),
        addedPageCount: patch.addedPageIds.length,
        removedPageCount: patch.removedPageIds.length,
      },
    );
  } else {
    await emitEvent(
      "structure_started",
      "Creating documentation structure.",
    );
    const proposedStructure = await suggestStructure(config, {
      analysis,
      answers: {},
      documentationBrief: config.documentationBrief,
      publishedStructure: regenerationAnchor ?? undefined,
      changedSourcePaths,
      maxPages: editorialPageBudget,
    }, onProgress);
    await emitEvent(
      "structure_review_started",
      "Reviewing documentation structure for public readers.",
      {
        proposedPageCount: countStructurePages(proposedStructure),
        editorialPageBudget,
      },
    );
    const reviewedStructure = await reviewDocumentationStructure(config, {
      analysis,
      structure: proposedStructure,
      maxPages: editorialPageBudget,
      documentationBrief: config.documentationBrief,
      publishedStructure: regenerationAnchor ?? undefined,
      changedSourcePaths,
      onDegraded: (unresolvedErrors) => {
        reviewDegraded = true;
        return emitEvent(
          "structure_review_degraded",
          `Structure review exhausted; continuing with the best usable structure: ${unresolvedErrors.join("; ")}`,
          { unresolvedErrors },
        );
      },
    }, onProgress, (summary) => {
      reviewDecisionSummary = summary;
    });
    // The model plans from page IDs only, so the routes that the published
    // pages had come back here, for every page the new plan kept.
    structure = keepPublishedRoutes(reviewedStructure, regenerationAnchor);
    if (reviewDecisionSummary) {
      await emitEvent(
        "structure_review_decided",
        "Structure review decided every page.",
        reviewDecisionTelemetry(reviewDecisionSummary),
      );
    }
  }

  structure = await applyGenerationProfileBudget(
    input,
    structure,
    emitEvent,
    { reviewDegraded },
  );

  const targets = flattenStructure(structure);
  assertUniqueStructurePageIds(structure);
  const incremental =
    snapshotWithDelta &&
    structuralFingerprint &&
    sourceState &&
    structurePlan
      ? await finalizeIncrementalPlan({
          analysis,
          documentationBrief: config.documentationBrief,
          planningFingerprint:
            input.planningFingerprint ?? DEFAULT_PLANNING_FINGERPRINT,
          writingFingerprint:
            input.writingFingerprint ?? "doxa-writing-contract-v1",
          reusableState: input.reusableState,
          snapshot: snapshotWithDelta,
          structuralFingerprint,
          structure,
          preliminaryPlan: structurePlan,
        })
      : null;
  await emitEvent(
    "structure_created",
    "Documentation structure checkpoint created.",
    {
      sectionCount: structure.sections.length,
      pageCount: targets.length,
      ...(incremental
        ? {
            reason: incremental.plan.reasons[0],
            reusePageCount: incremental.plan.reusePageIds.length,
            regeneratePageCount:
              incremental.plan.regeneratePageIds.length,
            ...(incremental.plan.causes
              ? {
                  regenerationCauses:
                    `new:${incremental.plan.causes.newPages}` +
                    `inputs:${incremental.plan.causes.inputChanged}` +
                    `deps:${incremental.plan.causes.dependencyChanged}` +
                    `instructions:${incremental.plan.causes.instructionsChanged ?? 0}`,
                }
              : {}),
          }
        : (reviewDecisionSummary ?? {})),
    },
  );
  const writerHandoff = buildWriterHandoff({
    analysis,
    structure,
    sourceRevision:
      preparedSnapshot?.outcome === "prepared"
        ? preparedSnapshot.snapshot.targetRevision
        : null,
    project: {
      name: input.projectName,
      slug: input.projectSlug,
    },
  });
  const routeRegistryHash = createHash("sha256")
    .update(JSON.stringify([...buildRouteRegistry(structure).routeSet].sort()))
    .digest("hex");
  return {
    stage: "structure",
    checkpoint: JSON.stringify(structure),
    pageIds: targets.map(stablePageId),
    pageInputHashes: buildPageInputHashMap(structure),
    routeRegistryHash,
    navigation: await buildDeterministicNavigation(structure, analysis),
    runtimeFeatures: resolveRestApiRuntimeFeatures(analysis),
    writerHandoff,
    ...(incremental
      ? {
          plan: incremental.plan,
          structureState: incremental.structureState,
        }
      : {}),
  };
}

async function prepareWorkspace(
  input: ContainerGenerationStageRequest,
  emitEvent: StageEventEmitter,
  abortController: AbortController,
  workspace: HostedWorkspaceLayout,
  runtime: GenerationStageRuntime,
): Promise<PreparedRepositorySnapshotResult | null> {
  const documentationBrief = resolveRunBrief(input);
  await emitEvent("container_stage_booted", `Agent container started ${input.stage} stage.`, {
    stage: input.stage,
    model: input.model ?? null,
    plannerModel: input.modelConfig?.plannerModel ?? null,
    writerModel: input.modelConfig?.writerModel ?? null,
    generationProfile: input.generationProfile,
    pageConcurrency: resolvedPageConcurrency(input),
    editorialPageBudget: resolvedEditorialPageBudget(input),
    repositoryFullName: input.repositoryFullName,
    documentationTarget: documentationBrief.target.kind,
    documentationPolicyVersion: PUBLIC_DOCUMENTATION_POLICY_VERSION,
    documentationBriefFingerprint: documentationBriefFingerprint(documentationBrief),
  });
  await rm(workspace.stageRoot, { recursive: true, force: true });
  await mkdir(workspace.artifactRoot, { recursive: true });
  await assertGitAvailable(undefined, abortController.signal);
  if (input.checkoutSpec) {
    await emitEvent(
      "snapshot_started",
      `Preparing exact source revision for ${input.repositoryFullName}.`,
      {
        checkoutKind: input.checkoutSpec.kind,
        targetRevision:
          input.checkoutSpec.kind === "pull_request_merge"
            ? input.checkoutSpec.headRevision
            : input.checkoutSpec.targetRevision,
      },
    );
    const result = await ensureRepositorySnapshot({
      repositoryFullName: input.repositoryFullName,
      installationAccessToken: input.installationAccessToken,
      checkoutSpec: input.checkoutSpec,
      destination: workspace.snapshotRoot,
    }, {
      onRetry: (retry) =>
        emitEvent(
          "snapshot_retrying",
          `GitHub snapshot attempt ${retry.attempt} of ${retry.maxAttempts} failed; ` +
            `retrying attempt ${retry.nextAttempt} in ${retry.delayMs}ms.`,
          {
            attempt: retry.attempt,
            nextAttempt: retry.nextAttempt,
            maxAttempts: retry.maxAttempts,
            delayMs: retry.delayMs,
            reason: retry.reason,
          },
        ),
      signal: abortController.signal,
      ...(runtime.repositoryUrl
        ? { repositoryUrl: runtime.repositoryUrl }
        : {}),
    });
    if (result.outcome === "merge_conflict") {
      await emitEvent(
        "snapshot_merge_conflict",
        result.message,
        { targetRevision: result.targetRevision },
      );
      return result;
    }
    await emitEvent(
      "snapshot_complete",
      `Exact source revision for ${input.repositoryFullName} is ready.`,
      {
        sourceTreeHash: result.snapshot.sourceTreeHash,
        sourceChangeCount: result.snapshot.changes.length,
        targetRevision: result.snapshot.targetRevision,
      },
    );
    return result;
  }

  await rm(workspace.snapshotRoot, { recursive: true, force: true });
  await mkdir(workspace.checkoutRoot, { recursive: true });
  await emitEvent("clone_started", `Cloning ${input.repositoryFullName}.`, {
    repositoryFullName: input.repositoryFullName,
    defaultBranch: input.defaultBranch ?? null,
  });
  await cloneRepository({
    fullName: input.repositoryFullName,
    branch: input.defaultBranch,
    token: input.installationAccessToken,
    targetDir: workspace.checkoutRoot,
  }, undefined, { skipGitCheck: true, signal: abortController.signal });
  await emitEvent("clone_complete", `Repository ${input.repositoryFullName} cloned.`);
  return null;
}

function createAgentConfig(
  input: ContainerGenerationStageRequest,
  abortController: AbortController,
  workspace: HostedWorkspaceLayout,
  observability: StageObservability,
  runtime: GenerationStageRuntime,
  onSpan: AgentSpanCallback,
  onWriterExplorationResolved: NonNullable<
    AgentConfig["onWriterExplorationResolved"]
  >,
  stageExecutionId: string,
): AgentConfig {
  const logWriterDiagnostic = createWriterDiagnosticLogger(input);
  return {
    cwd: workspace.checkoutRoot,
    artifactRoot: workspace.artifactRoot,
    toolPolicy: HOSTED_AGENT_TOOL_POLICY,
    outputDir: workspace.outputDir,
    modelProvider: input.modelProvider,
    apiKey: input.modelApiKey,
    authToken: input.modelAuthToken,
    model: input.model,
    modelCallTimeoutMs: positiveIntFromEnv(
      "DOXA_MODEL_CALL_IDLE_TIMEOUT_MS",
    ),
    modelCallMaxDurationMs: positiveIntFromEnv(
      "DOXA_MODEL_CALL_MAX_MS",
    ),
    ...(runtime.createProvider
      ? { provider: runtime.createProvider(input) }
      : {}),
    abortController,
    onWriterDiagnostic: (event) => {
      logWriterDiagnostic(event);
      runtime.onWriterDiagnostic?.(event);
    },
    onModelUsage: (record) => observability.onUsage?.(
      toGenerationUsageRecord(input, stageExecutionId, record),
    ),
    onSpan,
    onWriterExplorationResolved,
    onRepairDiagnostic: (diagnostic) => {
      return observability.onDiagnostic?.(
        toGenerationRepairDiagnostic(
          input,
          stageExecutionId,
          diagnostic,
        ),
      );
    },
    onPageGenerated: (page) =>
      observability.onPageCheckpoint?.(
        toStagedRuntimePage(page, workspace.outputRoot),
      ),
    ...writerWidthConfig(input),
    writerExploration: HOSTED_WRITER_EXPLORATION,
    writerMaxSteps: HOSTED_WRITER_MAX_STEPS,
    writerValidation: { ...HOSTED_WRITER_VALIDATION, forbiddenValues: outputSecrets(input) },
    docsQuality: HOSTED_DOCS_QUALITY,
    pageFailureMaxRetries: HOSTED_PAGE_FAILURE_MAX_RETRIES,
    pageRetryConcurrency: resolvedPageConcurrency(input),
    ...(input.modelConfig?.writerFallbackModel
      ? { writerFallbackModel: input.modelConfig.writerFallbackModel }
      : {}),
    onPageFailure: hostedPageFailureAction,
    onDocsQualityFailure: hostedDocsQualityFailureAction,
    documentationBrief: resolveRunBrief(input),
    // Each stage execution gets its own job instance; the analysis destroys it when done.
    specReader: (runtime.createSpecReader ?? resolveSpecReaderClient)(stageExecutionId),
  };
}

/** Page writers share the job's adaptive limiter, and throttling lowers it. */
function writerWidthConfig(
  input: ContainerGenerationStageRequest,
): Pick<AgentConfig, "concurrency" | "pageWriterLimiter" | "onModelCallRetry"> {
  const limiter = writerLimiterForJob(input.jobId, resolvedPageConcurrency(input));
  return {
    concurrency: limiter.max,
    pageWriterLimiter: limiter,
    onModelCallRetry: throttleOnRetry(limiter),
  };
}

/**
 * How much the review changed the proposed pages. Releasing pages to the
 * writers before the review ends pays off only when this share is small,
 * because a merged, moved or dropped page would be written in vain.
 */
export function reviewDecisionTelemetry(
  summary: StructureReviewDecisionSummary,
): Record<keyof StructureReviewDecisionSummary | "changedShare", number> {
  const { keepCount, mergeCount, moveCount, dropCount } = summary;
  const total = keepCount + mergeCount + moveCount + dropCount;
  const changed = mergeCount + moveCount + dropCount;
  return {
    keepCount,
    mergeCount,
    moveCount,
    dropCount,
    changedShare: total === 0 ? 0 : Math.round((changed / total) * 1_000) / 1_000,
  };
}

export function positiveIntFromEnv(
  name: string,
  environment: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = environment[name]?.trim();
  if (!raw) return undefined;

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function toGenerationUsageRecord(
  input: ContainerGenerationStageRequest,
  stageExecutionId: string,
  record: AgentUsageRecord,
): GenerationUsageRecord {
  const { context, usage } = record;
  const hasPage = context.pageId !== undefined && context.pageTitle !== undefined;
  return {
    callId: record.callId,
    jobId: input.jobId,
    stageExecutionId,
    stage: input.stage,
    operation: context.operation,
    modelRole: input.stage === "write" ? "writer" : "planner",
    model: record.model,
    pageId: hasPage ? context.pageId! : null,
    pageTitle: hasPage ? context.pageTitle! : null,
    pageRetry: context.pageRetry ?? null,
    attempt: context.attempt ?? null,
    iteration: record.iteration,
    providerGenerationId: record.providerGenerationId ?? null,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    cachedTokens: usage.cachedTokens ?? null,
    cacheWriteTokens: usage.cacheWriteTokens ?? null,
    reasoningTokens: usage.reasoningTokens ?? null,
    costUsd: toUsdDecimal(usage.cost),
    promptCostUsd: toUsdDecimal(usage.promptCost),
    completionCostUsd: toUsdDecimal(usage.completionCost),
    upstreamCostUsd: toUsdDecimal(usage.upstreamCost),
    durationMs: record.durationMs ?? null,
    finishReason: record.finishReason ?? null,
    recordedAt: record.recordedAt,
  };
}

/** One entry per page, with the reason of its last failure. */
export function toFailedStagePages(
  skipped: readonly PageGenerationFailure[],
): FailedStagePage[] {
  const lastFailureById = new Map(skipped.map((failure) => [failure.pageId, failure]));
  return [...lastFailureById.values()].map((failure) => ({
    id: failure.pageId,
    title: failure.title,
    reason: failure.reason.slice(0, FAILED_PAGE_REASON_MAX_CHARS),
  }));
}

const FAILED_PAGE_REASON_MAX_CHARS = 2_000;

export function toGenerationRepairDiagnostic(
  input: ContainerGenerationStageRequest,
  stageExecutionId: string,
  diagnostic: WriterRepairDiagnostic,
): GenerationRepairDiagnostic {
  const bounded = truncateGenerationDiagnosticDraft(
    diagnostic.draft.slice(0, GENERATION_DIAGNOSTIC_DRAFT_MAX_CHARS),
  );
  return {
    diagnosticId: crypto.randomUUID(),
    jobId: input.jobId,
    stageExecutionId,
    pageId: diagnostic.pageId,
    pageTitle: diagnostic.pageTitle,
    pageRetry: diagnostic.pageRetry,
    writerAttempt: diagnostic.writerAttempt,
    attempt: diagnostic.attempt,
    maxAttempts: diagnostic.maxAttempts,
    model: input.model ?? input.modelConfig?.writerModel ?? "unknown",
    rule: diagnostic.rule,
    message: diagnostic.message,
    line: diagnostic.line ?? null,
    column: diagnostic.column ?? null,
    snippet: diagnostic.snippet?.slice(0, 2_000) ?? null,
    draftSha256: createHash("sha256")
      .update(diagnostic.draft)
      .digest("hex"),
    draft: bounded.draft,
    draftTruncated:
      bounded.truncated ||
      diagnostic.draft.length > GENERATION_DIAGNOSTIC_DRAFT_MAX_CHARS,
    repairKind: diagnostic.repairKind,
    repairSucceeded: diagnostic.repairSucceeded,
    rejectionReason: diagnostic.rejectionReason?.slice(0, 2_000) ?? null,
    validationIssueCodes: diagnostic.validationIssueCodes.slice(0, 20),
    createdAt: new Date().toISOString(),
  };
}

function toUsdDecimal(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value) || value < 0) return null;
  return value.toFixed(12).replace(/(?:\.0+|(\.\d+?)0+)$/, "$1");
}

export async function buildDeterministicNavigation(
  structure: DocumentationStructure,
  analysis?: ProjectAnalysis,
): Promise<RuntimeDocsNavigation> {
  return buildDeterministicNavOrderManifest(structure, analysis);
}

function assertUniqueStructurePageIds(
  structure: DocumentationStructure,
): void {
  const errors = validateGlobalPageIds(structure);
  if (errors.length > 0) {
    throw new GenerationStageInvariantError(
      errors.join("; "),
      "duplicate_structure_page_id",
    );
  }
}

function parseCheckpoint(checkpoint: string, stage: string): unknown {
  try {
    return JSON.parse(checkpoint) as unknown;
  } catch {
    throw new GenerationStageInvariantError(
      `${stage} checkpoint is not valid JSON.`,
      "invalid_generation_checkpoint",
    );
  }
}

function parseStructureCheckpoint(checkpoint: string): DocumentationStructure {
  const value = parseCheckpoint(checkpoint, "structure");
  assertDocumentationStructure(value);
  return value;
}

function assertDocumentationStructure(value: unknown): asserts value is DocumentationStructure {
  if (!isRecord(value) || !Array.isArray(value.sections) || value.sections.length === 0) {
    throw new GenerationStageInvariantError(
      "Structure checkpoint is invalid.",
      "invalid_generation_checkpoint",
    );
  }
  for (const section of value.sections) {
    if (!isRecord(section) || typeof section.id !== "string" || typeof section.title !== "string" || !Array.isArray(section.pages)) {
      throw new GenerationStageInvariantError(
        "Structure checkpoint contains an invalid section.",
        "invalid_generation_checkpoint",
      );
    }
    for (const page of section.pages) {
      if (
        !isRecord(page) ||
        typeof page.id !== "string" ||
        typeof page.title !== "string" ||
        typeof page.description !== "string" ||
        (page.subPages !== undefined &&
          (!Array.isArray(page.subPages) || page.subPages.length > 0))
      ) {
        throw new GenerationStageInvariantError(
          "Structure checkpoint contains an invalid page.",
          "invalid_generation_checkpoint",
        );
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toStagedRuntimePage(
  page: GeneratedPageContent,
  outputRoot: string,
): StagedRuntimePage {
  const navigationPath = relative(outputRoot, page.path).replace(/\\/g, "/");
  const route = normalizeHref(navigationPath.replace(/^default\//, ""));
  const content = stripUnsupportedMdxEsm(page.content, (line) => {
    console.warn(JSON.stringify({
      service: "doxa-agent-container",
      eventType: "unsupported_mdx_esm_removed",
      route,
      droppedLine: line,
    }));
  });
  return {
    id: page.id,
    title: page.title,
    route,
    content,
    navigationPath,
    dependencies: page.dependencies,
    contentHash: createHash("sha256").update(content).digest("hex"),
    pageInputHash: page.pageInputHash,
  };
}
