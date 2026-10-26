import type { ServerResponse } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { relative } from "node:path";
import {
  analyzeProjectOnly,
  assertMdxValidatorReady,
  documentationBriefFingerprint,
  disposeMdxValidatorPool,
  generateDocumentation,
  PUBLIC_DOCUMENTATION_POLICY_VERSION,
  readNavOrderManifest,
  resolveRestApiRuntimeFeatures,
  reviewDocumentationStructure,
  suggestStructure,
  type AgentConfig,
  type AgentProgressEvent,
  type GeneratedPageContent,
  type StructureReviewDecisionSummary,
} from "@doxahq/agent";
import {
  type ContainerGenerateRequest,
  type ContainerGenerateResponse,
  type ContainerGenerationEvent,
  type ContainerGenerationStageRequest,
  type ContainerGenerationStageStreamRecord,
  type ContainerGenerateStreamRecord,
} from "@doxahq/contracts";
import { createRuntimeDocsArtifacts, normalizeHref, type RuntimeDocsPageInput } from "@doxahq/docs-engine";
import { assertGitAvailable, cloneRepository } from "./git";
import { referenceSourceLogEvent } from "./reference-source-event";
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
  resolvedRestExtractionModel,
} from "./generation-profile";
import { createContainerLogger, sanitizeText, sanitizeValue } from "./logging";
import { resolveSpecReaderClient } from "./utility/spec-reader-client";
import { createLocalAgentServer } from "./local-http-server";
import { startGenerationHeartbeat } from "./generation-heartbeat";
import { classifyGenerationStageError } from "./generation-stage-errors";
import { runGenerationStage } from "./staged-generation";
import { startContainerServer } from "./startup";
import { HOSTED_AGENT_TOOL_POLICY } from "./worker-core";
import {
  createHostedWorkspaceLayout,
  resolveHostedWorkspaceBaseDir,
  type HostedWorkspaceLayout,
} from "./workspace-layout";
import { stripUnsupportedMdxEsm } from "./runtime-page-content";
import { resolveRunBrief } from "./run-brief";

const port = Number(process.env.PORT ?? 8789);

await startContainerServer({
  port,
  preflight: async () => {
    // Fail at boot, not on the first generation, when the workspace root is
    // misconfigured.
    resolveHostedWorkspaceBaseDir();
    await assertMdxValidatorReady();
  },
  createServer: () => createLocalAgentServer({ generate, streamGeneration, streamGenerationStage }),
  onListening: () => {
    console.log(JSON.stringify({
      service: "doxa-agent-container",
      eventType: "server_listening",
      port,
    }));
  },
});

async function generate(
  input: ContainerGenerateRequest,
  abortController: AbortController,
): Promise<ContainerGenerateResponse> {
  const events: ContainerGenerationEvent[] = [];
  const result = await runGeneration(input, async (event) => {
    events.push(event);
  }, abortController);

  return {
    ...result,
    events,
  };
}

async function streamGeneration(
  response: ServerResponse,
  input: ContainerGenerateRequest,
  abortController: AbortController,
): Promise<void> {
  const secrets = [input.installationAccessToken, input.modelApiKey].filter(Boolean);
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
  });
  const stopHeartbeat = startGenerationHeartbeat((record) => {
    if (!response.writableEnded && !abortController.signal.aborted) {
      writeNdjson(response, record);
    }
  });

  try {
    const result = await runGeneration(input, async (event) => {
      writeNdjson(response, {
        kind: "event",
        event: sanitizeValue(event, secrets),
      });
    }, abortController);
    writeNdjson(response, {
      kind: "result",
      result,
    });
  } catch (error) {
    createContainerLogger(input, Date.now()).error(error instanceof Error ? error.message : "Generation failed");
    writeNdjson(response, {
      kind: "error",
      error: {
        message: sanitizeText(error instanceof Error ? error.message : "Generation failed", secrets),
      },
    });
  } finally {
    stopHeartbeat();
    response.end();
  }
}

async function streamGenerationStage(
  response: ServerResponse,
  input: ContainerGenerationStageRequest,
  abortController: AbortController,
): Promise<void> {
  const secrets = [input.installationAccessToken, input.modelApiKey].filter(Boolean);
  const startedAt = Date.now();
  const logger = createContainerLogger(input, startedAt);
  let sequence = 0;
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
  });
  const stopHeartbeat = startGenerationHeartbeat((record) => {
    if (!response.writableEnded && !abortController.signal.aborted) {
      writeStageNdjson(response, record);
    }
  });

  try {
    const result = await runGenerationStage(input, async (type, message, data) => {
      sequence += 1;
      const elapsedMs = Date.now() - startedAt;
      const event: ContainerGenerationEvent = {
        source: "container",
        sequence,
        type,
        message,
        elapsedMs,
        data: { elapsedMs, containerSequence: sequence, stage: input.stage, ...(data ?? {}) },
      };
      logger.event(event);
      writeStageNdjson(response, { kind: "event", event: sanitizeValue(event, secrets) });
    }, abortController, {
      onUsage: (record) => {
        writeStageNdjson(response, { kind: "usage", record });
      },
      onDiagnostic: (diagnostic) => {
        writeStageNdjson(response, { kind: "diagnostic", diagnostic });
      },
      onPageCheckpoint: (page) => {
        writeStageNdjson(response, { kind: "page_checkpoint", page });
      },
    });
    writeStageNdjson(response, { kind: "stage_result", result });
  } catch (error) {
    const classified = classifyGenerationStageError(error);
    logger.error(classified.message, {
      stage: input.stage,
      retryable: classified.retryable,
      code: classified.code,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    writeStageNdjson(response, {
      kind: "error",
      error: {
        message: sanitizeText(classified.message, secrets),
        retryable: classified.retryable,
        code: classified.code,
      },
    });
  } finally {
    stopHeartbeat();
    response.end();
  }
}

async function runGeneration(
  input: ContainerGenerateRequest,
  emit: (event: ContainerGenerationEvent) => Promise<void> | void,
  abortController: AbortController,
) {
  const workspace = createHostedWorkspaceLayout(
    resolveHostedWorkspaceBaseDir(),
    input.jobId,
  );
  try {
    return await runGenerationInWorkspace(
      input,
      emit,
      abortController,
      workspace,
    );
  } finally {
    await disposeMdxValidatorPool();
    await rm(workspace.jobRoot, { recursive: true, force: true });
  }
}

async function runGenerationInWorkspace(
  input: ContainerGenerateRequest,
  emit: (event: ContainerGenerationEvent) => Promise<void> | void,
  abortController: AbortController,
  workspace: HostedWorkspaceLayout,
) {
  const startedAt = Date.now();
  const logger = createContainerLogger(input, startedAt);
  let eventSequence = 0;
  let eventQueue = Promise.resolve();

  const emitEventNow = async (
    type: string,
    message: string,
    data?: Record<string, unknown>,
  ) => {
    eventSequence += 1;
    const elapsedMs = Date.now() - startedAt;
    const event: ContainerGenerationEvent = {
      source: "container",
      sequence: eventSequence,
      type,
      message,
      elapsedMs,
      data: {
        elapsedMs,
        containerSequence: eventSequence,
        ...(data ?? {}),
      },
    };
    logger.event(event);
    await emit(event);
  };
  const emitEvent = (
    type: string,
    message: string,
    data?: Record<string, unknown>,
  ) => {
    eventQueue = eventQueue.then(() => emitEventNow(type, message, data));
    return eventQueue;
  };
  const flushEvents = () => eventQueue;

  const outputRoot = workspace.outputRoot;
  const documentationBrief = resolveRunBrief(input);
  const documentationFingerprint = documentationBriefFingerprint(documentationBrief);

  await emitEvent("container_booted", "Agent container started generation.", {
    model: input.model ?? null,
    generationProfile: input.generationProfile,
    pageConcurrency: resolvedPageConcurrency(input),
    editorialPageBudget: resolvedEditorialPageBudget(input),
    repositoryFullName: input.repositoryFullName,
    documentationTarget: documentationBrief.target.kind,
    documentationPolicyVersion: PUBLIC_DOCUMENTATION_POLICY_VERSION,
    documentationBriefFingerprint: documentationFingerprint,
    projectContextLength: documentationBrief.projectContext?.length ?? 0,
    projectInstructionsVersion: documentationBrief.projectInstructions?.version ?? null,
  });
  await rm(workspace.jobRoot, { recursive: true, force: true });
  await Promise.all([
    mkdir(workspace.checkoutRoot, { recursive: true }),
    mkdir(workspace.artifactRoot, { recursive: true }),
  ]);

  await emitEvent("git_check_started", "Checking git availability.");
  await assertGitAvailable(undefined, abortController.signal);
  await emitEvent("git_check_complete", "Git is available.");
  await emitEvent("clone_started", `Cloning ${input.repositoryFullName}.`, {
    repositoryFullName: input.repositoryFullName,
    defaultBranch: input.defaultBranch ?? null,
  });
  await cloneRepository({
    fullName: input.repositoryFullName,
    branch: input.defaultBranch,
    token: input.installationAccessToken,
    targetDir: workspace.checkoutRoot,
  }, undefined, {
    skipGitCheck: true,
    signal: abortController.signal,
  });
  await emitEvent("clone_complete", `Repository ${input.repositoryFullName} cloned.`, {
    repositoryFullName: input.repositoryFullName,
  });

  const onProgress = (event: AgentProgressEvent) => {
    const type = eventTypeForProgress(event);
    if (!type) return;
    void emitEvent(type, event.message, {
      stage: event.stage,
      progress: event.progress,
      currentItem: event.currentItem,
    });
  };
  await emitEvent("profile_selected", `Using ${input.generationProfile} generation profile.`, {
    generationProfile: input.generationProfile,
    pageConcurrency: resolvedPageConcurrency(input),
    editorialPageBudget: resolvedEditorialPageBudget(input),
    model: input.model ?? null,
  });

  const config: AgentConfig = {
    cwd: workspace.checkoutRoot,
    artifactRoot: workspace.artifactRoot,
    toolPolicy: HOSTED_AGENT_TOOL_POLICY,
    outputDir: workspace.outputDir,
    modelProvider: input.modelProvider,
    apiKey: input.modelApiKey,
    model: input.model,
    abortController,
    concurrency: resolvedPageConcurrency(input),
    writerExploration: HOSTED_WRITER_EXPLORATION,
    writerMaxSteps: HOSTED_WRITER_MAX_STEPS,
    writerValidation: HOSTED_WRITER_VALIDATION,
    docsQuality: HOSTED_DOCS_QUALITY,
    pageFailureMaxRetries: HOSTED_PAGE_FAILURE_MAX_RETRIES,
    onPageFailure: hostedPageFailureAction,
    onDocsQualityFailure: hostedDocsQualityFailureAction,
    documentationBrief,
    specReader: resolveSpecReaderClient(input.stageExecutionId ?? crypto.randomUUID()),
    restExtractionModel: resolvedRestExtractionModel(input),
  };

  await emitEvent("analysis_started", "Analyzing repository.");
  const analysis = await analyzeProjectOnly(config, onProgress);
  if (analysis.referenceSourceReport) {
    const line = referenceSourceLogEvent(analysis.referenceSourceReport);
    await emitEvent(line.type, line.message, { ...line.data });
  }
  await flushEvents();
  await emitEvent("structure_started", "Creating documentation structure.");
  const editorialPageBudget = resolvedEditorialPageBudget(input);
  const proposedStructure = await suggestStructure(config, {
    analysis,
    answers: {},
    documentationBrief,
    maxPages: editorialPageBudget,
  }, onProgress);
  await flushEvents();
  await emitEvent("structure_review_started", "Reviewing documentation structure for public readers.", {
    proposedPageCount: countStructurePages(proposedStructure),
    editorialPageBudget,
  });
  let reviewDecisionSummary: StructureReviewDecisionSummary | undefined;
  let reviewDegraded = false;
  const reviewedStructure = await reviewDocumentationStructure(config, {
    analysis,
    structure: proposedStructure,
    maxPages: editorialPageBudget,
    documentationBrief,
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
  await flushEvents();
  await emitEvent("structure_reviewed", "Documentation structure reviewed for public readers.", {
    proposedPageCount: countStructurePages(proposedStructure),
    reviewedPageCount: countStructurePages(reviewedStructure),
    editorialPageBudget,
    ...(reviewDecisionSummary ?? {}),
  });
  const structure = await applyGenerationProfileBudget(input, reviewedStructure, emitEvent, {
    reviewDegraded,
  });
  await emitEvent("structure_created", "Documentation structure created.", {
    sectionCount: structure.sections.length,
    pageCount: countStructurePages(structure),
  });

  await emitEvent("writing_started", "Writing documentation pages.");
  const generation = await generateDocumentation(
    config,
    structure,
    onProgress,
    { analysis, answers: {}, structure, documentationBrief },
  );
  await flushEvents();

  for (const page of generation.pages) {
    await emitEvent("page_written", `Wrote ${page.title}.`, {
      title: page.title,
      path: relative(outputRoot, page.path).replace(/\\/g, "/"),
    });
  }

  await emitEvent("pages_written", `${generation.pages.length} documentation page(s) written.`, {
    pageCount: generation.pages.length,
    skippedPageCount: generation.skippedPages.length,
    failedPageCount: generation.failedPages.length,
  });

  const pages = generation.pages.map((page) => toRuntimePage(page, outputRoot));
  const navigation = await readNavOrderManifest(outputRoot);
  const bundle = await createRuntimeDocsArtifacts({
    siteId: input.siteId,
    versionId: input.versionId,
    projectSlug: input.projectSlug,
    projectName: input.projectName,
    pages,
    siteConfig: input.siteConfig,
    entitlements: input.entitlements,
    navigation,
    features: resolveRestApiRuntimeFeatures(analysis),
  });

  await emitEvent("artifact_bundle_created", "Runtime artifact bundle created.", {
    fileCount: bundle.files.length,
  });
  await emitEvent("container_complete", "Agent container completed generation.", {
    fileCount: bundle.files.length,
  });

  return {
    ok: true as const,
    jobId: input.jobId,
    files: bundle.files,
  };
}

function toRuntimePage(page: GeneratedPageContent, outputRoot: string): RuntimeDocsPageInput {
  const navigationPath = relative(outputRoot, page.path).replace(/\\/g, "/");
  const route = normalizeHref(navigationPath.replace(/^default\//, ""));
  return {
    title: page.title,
    route,
    content: stripUnsupportedMdxEsm(page.content, (line) => {
      console.warn(JSON.stringify({
        service: "doxa-agent-container",
        eventType: "unsupported_mdx_esm_removed",
        route,
        droppedLine: line,
      }));
    }),
    navigationPath,
  };
}

function eventTypeForProgress(event: AgentProgressEvent): string | null {
  if (event.stage === "analyzing") return "analysis_progress";
  if (event.stage === "writing") return "page_write_completed";
  return null;
}

function writeNdjson(response: ServerResponse, value: ContainerGenerateStreamRecord): void {
  response.write(`${JSON.stringify(value)}\n`);
}

function writeStageNdjson(response: ServerResponse, value: ContainerGenerationStageStreamRecord): void {
  response.write(`${JSON.stringify(value)}\n`);
}
