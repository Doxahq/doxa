import {
  type StaleGenerationJobDto,
  containerGenerateStreamRecordSchema,
  containerGenerateResponseSchema,
  type ContainerArtifactFile,
  type ContainerGenerateHeartbeatRecord,
  type ContainerGenerateResponse,
  type ContainerGenerateRequest,
  type ContainerGenerationEvent,
  type GenerationProfile,
  type GenerationContext,
  type JobEventSource,
} from "@doxahq/contracts";
import {
  buildArtifactPrefix,
  findEmbeddedMetadataArtifact,
  manifestPathForPrefix,
  parseDocsManifestText,
} from "@doxahq/docs-engine";
import { writingStageTimeoutMs as calculateWritingStageTimeoutMs } from "./generation-budget";

export {
  assessGenerationFeasibility,
  planPageBatches,
  writingStageTimeoutMs,
  type GenerationFeasibility,
  type GenerationFeasibilityInput,
  type WriteGroupBudget,
  type WritingStageBudgetInput,
} from "./generation-budget";
export {
  createRepositorySnapshot,
  normalizeSourceChanges,
} from "./source-checkout";
export {
  validateArtifactLinks,
  type ArtifactLinkWarning,
} from "./artifact-links";

export type GenerationMode = "starter-dev" | "container-inline" | "queue";

export interface GenerationInternalApi {
  getGenerationContext(projectId: string): Promise<GenerationContext | null>;
  createInstallationAccessToken(installationId: string): Promise<string>;
  markJobRunning(jobId: string): Promise<void>;
  markJobFailed(jobId: string, message: string): Promise<void>;
  markJobCancelled(jobId: string, message: string): Promise<void>;
  isJobActive(jobId: string): Promise<boolean>;
  getGenerationControl(): Promise<{ status: "enabled" | "paused"; reason: string | null }>;
  listStaleGenerationJobs(input: {
    queuedStaleSeconds: number;
    runningStaleSeconds: number;
  }): Promise<StaleGenerationJobDto[]>;
  addJobEvent(
    jobId: string,
    type: string,
    message: string,
    data?: Record<string, unknown>,
    source?: JobEventSource,
  ): Promise<void>;
  publishJobOutput(input: {
    jobId: string;
    artifactPrefix: string;
    manifestPath: string;
  }): Promise<{ versionId: string }>;
}

export interface ArtifactStore {
  /** Stores one file under its logical key `{artifactPrefix}/{path}`. */
  put(path: string, content: string, contentType: string): Promise<void>;
  /**
   * Makes the files under `artifactPrefix` visible as one immutable version.
   * Content-addressed storage writes the version tree here, after every file.
   */
  commit(artifactPrefix: string): Promise<void>;
}

export interface RunRealGenerationInput {
  jobId: string;
  projectId: string;
}

export interface AgentContainerBinding {
  fetch(request: Request): Promise<Response>;
}

export interface RunRealGenerationDeps {
  mode: GenerationMode;
  internal: GenerationInternalApi;
  artifacts: ArtifactStore;
  agentContainerBinding?: AgentContainerBinding;
  agentContainerUrl?: string;
  openRouterApiKey?: string;
  model?: string;
  generationProfile?: GenerationProfile;
  pageConcurrency?: number;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  overallTimeoutMs?: number;
  analysisTimeoutMs?: number;
  structureTimeoutMs?: number;
  pageBatchTimeoutMs?: number;
  finalizationTimeoutMs?: number;
  fetch?: typeof fetch;
  randomUUID?: () => string;
}

export class GenerationJobFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationJobFailedError";
  }
}

export class GenerationInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationInfrastructureError";
  }
}

export class GenerationJobInactiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationJobInactiveError";
  }
}

class AgentContainerTimeoutError extends Error {
  constructor(
    message: string,
    readonly timeoutMs: number,
  ) {
    super(message);
    this.name = "AgentContainerTimeoutError";
  }
}

class AgentContainerIdleTimeoutError extends Error {
  constructor(
    message: string,
    readonly idleTimeoutMs: number,
  ) {
    super(message);
    this.name = "AgentContainerIdleTimeoutError";
  }
}

type GenerationStage = "analysis" | "structure" | "writing" | "finalization";

class AgentContainerStageTimeoutError extends Error {
  constructor(
    message: string,
    readonly stage: GenerationStage,
    readonly timeoutMs: number,
  ) {
    super(message);
    this.name = "AgentContainerStageTimeoutError";
  }
}

const AGENT_CONTAINER_DESTROY_TIMEOUT_MS = 2_000;
const AGENT_CONTAINER_IDLE_TIMEOUT_MS = 90_000;

export async function runRealGenerationJob(
  input: RunRealGenerationInput,
  deps: RunRealGenerationDeps,
): Promise<{ versionId: string }> {
  const secrets = [deps.openRouterApiKey].filter((value): value is string => Boolean(value));

  try {
    await deps.internal.markJobRunning(input.jobId);

    await deps.internal.addJobEvent(
      input.jobId,
      "github_context_loading",
      "Loading project and repository context.",
      undefined,
      "worker",
    );
    const context = await deps.internal.getGenerationContext(input.projectId);
    if (!context) throw new Error("Generation context not found for project.");

    await deps.internal.addJobEvent(
      input.jobId,
      "github_context_loaded",
      `Using repository ${context.repository.fullName}.`,
      {
        repositoryFullName: context.repository.fullName,
        defaultBranch: context.repository.defaultBranch,
      },
      "worker",
    );

    await deps.internal.addJobEvent(
      input.jobId,
      "github_token_creating",
      "Creating short-lived GitHub installation token.",
      undefined,
      "worker",
    );
    const installationToken = await deps.internal.createInstallationAccessToken(
      context.repository.installationId,
    );
    secrets.push(installationToken);
    await deps.internal.addJobEvent(
      input.jobId,
      "github_token_created",
      "GitHub installation token created.",
      undefined,
      "worker",
    );

    if (!deps.openRouterApiKey) {
      throw new Error("OPENROUTER_API_KEY is required for real docs generation.");
    }
    if (isPlaceholderOpenRouterApiKey(deps.openRouterApiKey)) {
      throw new Error("OPENROUTER_API_KEY must be configured with a real OpenRouter API key.");
    }

    const versionId = deps.randomUUID?.() ?? crypto.randomUUID();
    const artifactPrefix = buildArtifactPrefix(context.project.siteId, versionId);
    const request: ContainerGenerateRequest = {
      jobId: input.jobId,
      repositoryFullName: context.repository.fullName,
      defaultBranch: context.repository.defaultBranch,
      installationAccessToken: installationToken,
      modelProvider: "openrouter",
      modelApiKey: deps.openRouterApiKey,
      model: deps.model,
      generationProfile: deps.generationProfile ?? "fast-mvp",
      pageConcurrency: deps.pageConcurrency,
      siteId: context.project.siteId,
      versionId,
      projectSlug: context.project.slug,
      projectName: context.project.name,
      siteConfig: context.siteConfig,
      entitlements: context.entitlements,
    };

    await ensureJobStillActive(input.jobId, deps);
    await deps.internal.addJobEvent(input.jobId, "container_requested", "Agent container request started.", {
      mode: deps.mode,
      model: deps.model ?? null,
      generationProfile: request.generationProfile,
      pageConcurrency: request.pageConcurrency ?? null,
      timeoutMs: deps.timeoutMs ?? null,
      overallTimeoutMs: deps.overallTimeoutMs ?? null,
      analysisTimeoutMs: deps.analysisTimeoutMs ?? null,
      structureTimeoutMs: deps.structureTimeoutMs ?? null,
      pageBatchTimeoutMs: deps.pageBatchTimeoutMs ?? null,
      finalizationTimeoutMs: deps.finalizationTimeoutMs ?? null,
    }, "worker");

    const generated = await callAgentContainer(request, deps, {
      onHeartbeat: async () => {
        await ensureJobStillActive(input.jobId, deps);
      },
      onEvent: async (event) => {
        await ensureJobStillActive(input.jobId, deps);
        const sanitizedEvent = sanitizeEvent(event, secrets);
        await deps.internal.addJobEvent(
          input.jobId,
          sanitizedEvent.type,
          sanitizedEvent.message,
          sanitizedEvent.data,
          sanitizedEvent.source ?? "container",
        );
      },
    });

    for (const event of generated.events) {
      const sanitizedEvent = sanitizeEvent(event, secrets);
      await deps.internal.addJobEvent(
        input.jobId,
        sanitizedEvent.type,
        sanitizedEvent.message,
        sanitizedEvent.data,
        sanitizedEvent.source ?? "container",
      );
    }

    await ensureJobStillActive(input.jobId, deps);
    validateArtifactFiles(generated.files);
    await writeArtifactFiles(deps.artifacts, artifactPrefix, generated.files);
    await deps.internal.addJobEvent(
      input.jobId,
      "artifacts_uploaded",
      "Generated docs artifacts uploaded to R2.",
      { fileCount: generated.files.length },
      "worker",
    );

    await ensureJobStillActive(input.jobId, deps);
    const manifestPath = manifestPathForPrefix(artifactPrefix);
    const published = await deps.internal.publishJobOutput({
      jobId: input.jobId,
      artifactPrefix,
      manifestPath,
    });

    return published;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Generation failed.";
    if (err instanceof GenerationJobInactiveError || errorMessage === "Generation job is no longer active.") {
      throw new GenerationJobFailedError(errorMessage);
    }
    if (await isJobInactive(input.jobId, deps)) {
      throw new GenerationJobFailedError("Generation job is no longer active.");
    }
    if (err instanceof GenerationInfrastructureError) {
      const message = sanitizeErrorMessage(err.message, secrets);
      throw new GenerationInfrastructureError(message);
    }

    const message = sanitizeErrorMessage(
      errorMessage,
      secrets,
    );
    if (err instanceof AgentContainerTimeoutError) {
      await deps.internal.markJobFailed(input.jobId, message);
      const destroyRequested = await requestAgentContainerDestroy(input.jobId, deps);
      await deps.internal.addJobEvent(
        input.jobId,
        "container_timed_out",
        message,
        {
          timeoutMs: err.timeoutMs,
          destroyRequested,
        },
        "worker",
      ).catch(() => undefined);
      throw new GenerationJobFailedError(message);
    }
    if (err instanceof AgentContainerIdleTimeoutError) {
      await deps.internal.markJobFailed(input.jobId, message);
      const destroyRequested = await requestAgentContainerDestroy(input.jobId, deps);
      await deps.internal.addJobEvent(
        input.jobId,
        "container_idle_timed_out",
        message,
        {
          idleTimeoutMs: err.idleTimeoutMs,
          destroyRequested,
        },
        "worker",
      ).catch(() => undefined);
      throw new GenerationJobFailedError(message);
    }
    if (err instanceof AgentContainerStageTimeoutError) {
      await deps.internal.markJobFailed(input.jobId, message);
      const destroyRequested = await requestAgentContainerDestroy(input.jobId, deps);
      await deps.internal.addJobEvent(
        input.jobId,
        "container_stage_timed_out",
        message,
        {
          stage: err.stage,
          timeoutMs: err.timeoutMs,
          destroyRequested,
        },
        "worker",
      ).catch(() => undefined);
      throw new GenerationJobFailedError(message);
    }
    await deps.internal.markJobFailed(input.jobId, message);
    throw new GenerationJobFailedError(message);
  }
}

function isPlaceholderOpenRouterApiKey(apiKey: string): boolean {
  return apiKey === "your_key" || apiKey === "replace-with-openrouter-api-key";
}

async function callAgentContainer(
  input: ContainerGenerateRequest,
  deps: RunRealGenerationDeps,
  callbacks: {
    onHeartbeat?: (heartbeat: ContainerGenerateHeartbeatRecord) => Promise<void>;
    onEvent?: (event: ContainerGenerationEvent) => Promise<void>;
  } = {},
): Promise<ContainerGenerateResponse> {
  const baseUrl = deps.agentContainerUrl?.replace(/\/+$/, "");
  if (!deps.agentContainerBinding && !baseUrl) {
    throw new Error(
      "An internal agent container binding or AGENT_CONTAINER_URL is required for real docs generation.",
    );
  }

  const fetchImpl = deps.fetch ?? fetch;
  const stageAwareTimeouts = deps.overallTimeoutMs !== undefined;
  const timeoutMs = positiveDuration(
    deps.overallTimeoutMs,
    positiveDuration(deps.timeoutMs, 15 * 60_000),
  );
  const idleTimeoutMs = positiveDuration(deps.idleTimeoutMs, AGENT_CONTAINER_IDLE_TIMEOUT_MS);
  const controller = new AbortController();
  const timeoutMessage = agentContainerTimeoutMessage(timeoutMs);
  const idleTimeoutMessage = agentContainerIdleTimeoutMessage(idleTimeoutMs);

  let timeout: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new AgentContainerTimeoutError(timeoutMessage, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const idleDeadline = createContainerIdleDeadline(
    idleTimeoutMs,
    idleTimeoutMessage,
    controller,
  );
  const stageDeadline = stageAwareTimeouts
    ? createContainerStageDeadline(input, deps, controller)
    : null;

  try {
    const requestInit: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: controller.signal,
    };

    const operation = (async () => {
      const response = await sendAgentContainerRequest(input, deps, requestInit, baseUrl, fetchImpl);
      const contentType = response.headers.get("content-type") ?? "";
      let generated: ContainerGenerateResponse;

      if (response.ok && contentType.includes("application/x-ndjson")) {
        generated = await readContainerStream(response, {
          onHeartbeat: async (heartbeat) => {
            idleDeadline.recordActivity();
            await callbacks.onHeartbeat?.(heartbeat);
          },
          onEvent: async (event) => {
            idleDeadline.recordActivity();
            stageDeadline?.recordEvent(event);
            await callbacks.onEvent?.(event);
          },
        });
      } else {
        generated = await readContainerJsonResponse(response);
      }

      return generated;
    })();

    return await Promise.race([
      operation,
      deadline,
      idleDeadline.promise,
      ...(stageDeadline ? [stageDeadline.promise] : []),
    ]);
  } catch (err) {
    if (
      err instanceof AgentContainerTimeoutError ||
      err instanceof AgentContainerIdleTimeoutError ||
      err instanceof AgentContainerStageTimeoutError
    ) {
      throw err;
    }
    if (controller.signal.aborted) {
      if (controller.signal.reason instanceof Error) {
        throw controller.signal.reason;
      }
      throw new AgentContainerTimeoutError(
        timeoutMessage,
        timeoutMs,
      );
    }
    throw err;
  } finally {
    if (!controller.signal.aborted) controller.abort();
    if (timeout !== null) clearTimeout(timeout);
    idleDeadline.clear();
    stageDeadline?.clear();
  }
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function agentContainerTimeoutMessage(timeoutMs: number): string {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return `Agent container timed out after ${timeoutSeconds} ${timeoutSeconds === 1 ? "second" : "seconds"}.`;
}

function agentContainerIdleTimeoutMessage(idleTimeoutMs: number): string {
  const idleTimeoutSeconds = Math.max(1, Math.ceil(idleTimeoutMs / 1000));
  return `Agent container stopped responding for ${idleTimeoutSeconds} ${idleTimeoutSeconds === 1 ? "second" : "seconds"}.`;
}

function agentContainerStageTimeoutMessage(stage: GenerationStage, timeoutMs: number): string {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return `Agent container ${stage} stage timed out after ${timeoutSeconds} ${timeoutSeconds === 1 ? "second" : "seconds"}.`;
}

interface ContainerIdleDeadline {
  promise: Promise<never>;
  recordActivity(): void;
  clear(): void;
}

interface ContainerStageDeadline {
  promise: Promise<never>;
  recordEvent(event: ContainerGenerationEvent): void;
  clear(): void;
}

function createContainerStageDeadline(
  input: ContainerGenerateRequest,
  deps: RunRealGenerationDeps,
  controller: AbortController,
): ContainerStageDeadline {
  const analysisTimeoutMs = positiveDuration(deps.analysisTimeoutMs, 45 * 60_000);
  const structureTimeoutMs = positiveDuration(deps.structureTimeoutMs, 30 * 60_000);
  const pageBatchTimeoutMs = positiveDuration(deps.pageBatchTimeoutMs, 30 * 60_000);
  const finalizationTimeoutMs = positiveDuration(deps.finalizationTimeoutMs, 10 * 60_000);
  let timeout: ReturnType<typeof setTimeout> | null = null;
  // The structure_created event replaces this with the real page count.
  let plannedPageCount = 1;
  let rejectDeadline: ((error: AgentContainerStageTimeoutError) => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });

  const setStage = (stage: GenerationStage, timeoutMs: number) => {
    if (timeout !== null) clearTimeout(timeout);
    timeout = setTimeout(() => {
      const error = new AgentContainerStageTimeoutError(
        agentContainerStageTimeoutMessage(stage, timeoutMs),
        stage,
        timeoutMs,
      );
      controller.abort(error);
      rejectDeadline?.(error);
    }, timeoutMs);
  };

  setStage("analysis", analysisTimeoutMs);

  return {
    promise,
    recordEvent(event) {
      if (event.type === "structure_created") {
        const pageCount = event.data?.pageCount;
        if (typeof pageCount === "number" && Number.isInteger(pageCount) && pageCount > 0) {
          plannedPageCount = pageCount;
        }
        return;
      }
      if (event.type === "analysis_started") {
        setStage("analysis", analysisTimeoutMs);
      } else if (event.type === "structure_started") {
        setStage("structure", structureTimeoutMs);
      } else if (event.type === "writing_started") {
        setStage("writing", calculateWritingStageTimeoutMs({
          pageCount: plannedPageCount,
          // One container writes every page, so each width of pages gets one batch timeout.
          pagesPerBatch: input.pageConcurrency ?? 1,
          pageBatchTimeoutMs,
        }));
      } else if (event.type === "pages_written") {
        setStage("finalization", finalizationTimeoutMs);
      }
    },
    clear() {
      if (timeout !== null) clearTimeout(timeout);
    },
  };
}

function createContainerIdleDeadline(
  idleTimeoutMs: number,
  message: string,
  controller: AbortController,
): ContainerIdleDeadline {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let rejectDeadline: ((reason: AgentContainerIdleTimeoutError) => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });

  const recordActivity = () => {
    if (controller.signal.aborted) return;
    if (timeout !== null) clearTimeout(timeout);
    timeout = setTimeout(() => {
      const error = new AgentContainerIdleTimeoutError(message, idleTimeoutMs);
      controller.abort(error);
      rejectDeadline?.(error);
    }, idleTimeoutMs);
  };

  recordActivity();

  return {
    promise,
    recordActivity,
    clear() {
      if (timeout !== null) clearTimeout(timeout);
    },
  };
}

export interface AgentContainerDestroyOptions {
  /**
   * True when the job can continue later (a credit stop or a failed step).
   * The local container then stops the running requests but accepts the
   * next request of the job. Without it, the local container refuses the
   * job for 15 minutes, so a queue that delivers a cancelled job again
   * cannot start it. A deployed container starts again on the next request
   * either way.
   */
  readonly resumable?: boolean;
}

export async function requestAgentContainerDestroy(
  jobId: string,
  deps: Pick<
    RunRealGenerationDeps,
    "agentContainerBinding" | "agentContainerUrl" | "fetch"
  >,
  options: AgentContainerDestroyOptions = {},
): Promise<boolean> {
  const pathname = `/admin/containers/${encodeURIComponent(jobId)}/destroy${options.resumable ? "?resumable=1" : ""}`;

  if (deps.agentContainerBinding) {
    try {
      const response = await requestWithDestroyDeadline(
        (signal) => deps.agentContainerBinding!.fetch(
          new Request(`https://agent-container.internal${pathname}`, {
            method: "POST",
            signal,
          }),
        ),
      );
      if (response.ok) return true;
    } catch {
      // Local Wrangler service bindings may be unavailable while the HTTP fallback is running.
    }
  }

  const baseUrl = deps.agentContainerUrl?.replace(/\/+$/, "");
  if (!baseUrl) return false;

  try {
    const response = await requestWithDestroyDeadline(
      (signal) => (deps.fetch ?? fetch)(`${baseUrl}${pathname}`, {
        method: "POST",
        signal,
      }),
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function requestWithDestroyDeadline(
  request: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("Agent container destroy request timed out."));
    }, AGENT_CONTAINER_DESTROY_TIMEOUT_MS);
  });

  try {
    return await Promise.race([request(controller.signal), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function ensureJobStillActive(jobId: string, deps: RunRealGenerationDeps): Promise<void> {
  const active = await deps.internal.isJobActive(jobId);
  if (!active) {
    throw new GenerationJobInactiveError("Generation job is no longer active.");
  }
}

async function isJobInactive(jobId: string, deps: RunRealGenerationDeps): Promise<boolean> {
  try {
    return !(await deps.internal.isJobActive(jobId));
  } catch {
    return false;
  }
}

async function readContainerJsonResponse(response: Response): Promise<ContainerGenerateResponse> {
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `Agent container request failed (${response.status}).`;
    if (isRetryableContainerStatus(response.status)) {
      throw new GenerationInfrastructureError(message);
    }
    throw new Error(message);
  }

  const parsed = containerGenerateResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Agent container returned an invalid generation response.");
  }

  return parsed.data;
}

async function sendAgentContainerRequest(
  input: ContainerGenerateRequest,
  deps: RunRealGenerationDeps,
  requestInit: RequestInit,
  baseUrl: string | undefined,
  fetchImpl: typeof fetch,
): Promise<Response> {
  if (deps.agentContainerBinding) {
    try {
      const response = await deps.agentContainerBinding.fetch(
        new Request("https://agent-container.internal/generate/stream", requestInit),
      );
      if (!baseUrl || !isRetryableContainerStatus(response.status)) return response;
    } catch (err) {
      if (!baseUrl) {
        throw new GenerationInfrastructureError(
          `Agent container binding request failed: ${errorMessageFor(err)}`,
        );
      }
    }
  }

  if (!baseUrl) {
    throw new Error(
      "An internal agent container binding or AGENT_CONTAINER_URL is required for real docs generation.",
    );
  }

  try {
    return await fetchImpl(`${baseUrl}/generate/stream`, requestInit);
  } catch {
    const message =
      "Agent container is unavailable. Ensure the configured agent container service is running and reachable.";

    if (deps.mode === "queue") {
      throw new GenerationInfrastructureError(message);
    }

    throw new Error(message);
  }
}

async function readContainerStream(
  response: Response,
  callbacks: {
    onHeartbeat?: (heartbeat: ContainerGenerateHeartbeatRecord) => Promise<void>;
    onEvent?: (event: ContainerGenerationEvent) => Promise<void>;
  },
): Promise<ContainerGenerateResponse> {
  if (!response.body) {
    throw new Error("Agent container stream response did not include a body.");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let result: ContainerGenerateResponse | null = null;

  async function consumeLine(line: string) {
    if (!line.trim()) return;

    let rawRecord: unknown;
    try {
      rawRecord = JSON.parse(line);
    } catch {
      throw new Error("Agent container stream returned malformed JSON.");
    }

    const parsed = containerGenerateStreamRecordSchema.safeParse(rawRecord);
    if (!parsed.success) {
      throw new Error("Agent container stream returned an invalid record.");
    }

    if (parsed.data.kind === "heartbeat") {
      await callbacks.onHeartbeat?.(parsed.data);
      return;
    }

    if (parsed.data.kind === "event") {
      await callbacks.onEvent?.(parsed.data.event);
      return;
    }

    if (parsed.data.kind === "error") {
      throw new Error(parsed.data.error.message);
    }

    result = {
      ...parsed.data.result,
      events: [],
    };
  }

  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        await consumeLine(line);
      }
    }

    if (done) {
      buffer += decoder.decode();
      if (buffer.trim()) {
        await consumeLine(buffer);
      }
      break;
    }
  }

  if (!result) {
    throw new Error("Agent container stream ended without a result.");
  }

  return result;
}

function isRetryableContainerStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function errorMessageFor(err: unknown): string {
  return err instanceof Error ? err.message : "request failed";
}

export function validateArtifactFiles(files: ContainerArtifactFile[]): void {
  const manifest = files.find((file) => file.path === "manifest.json");
  if (!manifest) throw new Error("Generated artifacts are missing manifest.json.");

  for (const file of files) {
    if (file.path.startsWith("/") || file.path.includes("..") || file.path.includes("\\")) {
      throw new Error(`Generated artifact has an unsafe path: ${file.path}`);
    }
  }

  const parsedManifest = parseDocsManifestText(manifest.content);
  if (!parsedManifest.ok) {
    if (parsedManifest.reason === "unsupported_schema_version") {
      throw new Error(
        `Generated manifest.json uses unsupported artifact schema version ${parsedManifest.schemaVersion}.`,
      );
    }
    throw new Error("Generated manifest.json is invalid.");
  }

  const filesByPath = new Map(files.map((file) => [file.path, file]));
  for (const page of parsedManifest.manifest.pages) {
    const source = filesByPath.get(page.sourcePath);
    if (!source) {
      throw new Error(`Generated artifacts are missing page source: ${page.sourcePath}`);
    }

    if (findEmbeddedMetadataArtifact(source.content)) {
      throw new Error(
        `Generated page source contains duplicated frontmatter metadata: ${page.sourcePath}`,
      );
    }
  }
}

export async function writeArtifactFiles(
  artifacts: ArtifactStore,
  artifactPrefix: string,
  files: ContainerArtifactFile[],
): Promise<void> {
  for (const file of files) {
    await artifacts.put(`${artifactPrefix}/${file.path}`, file.content, file.contentType);
  }
  await artifacts.commit(artifactPrefix);
}

export function sanitizeErrorMessage(message: string, secrets: string[]): string {
  return secrets.reduce((value, secret) => {
    if (!secret) return value;
    return [secret, encodeURIComponent(secret)].reduce(
      (current, candidate) => current.split(candidate).join("[redacted]"),
      value,
    );
  }, message);
}

export function sanitizeEvent(event: ContainerGenerationEvent, secrets: string[]): ContainerGenerationEvent {
  return {
    source: event.source,
    sequence: event.sequence,
    type: event.type,
    message: sanitizeErrorMessage(event.message, secrets),
    elapsedMs: event.elapsedMs,
    data: event.data ? sanitizeObject(event.data, secrets) : undefined,
  };
}

function sanitizeObject(value: Record<string, unknown>, secrets: string[]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizeUnknown(entry, secrets)]),
  );
}

function sanitizeUnknown(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return sanitizeErrorMessage(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => sanitizeUnknown(entry, secrets));
  if (value && typeof value === "object") return sanitizeObject(value as Record<string, unknown>, secrets);
  return value;
}
