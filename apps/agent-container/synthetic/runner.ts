import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  Provider,
} from "@doxahq/agent";
import {
  containerGenerationStageRequestSchema,
  containerGenerationStageStreamRecordSchema,
  type CompleteJobOutputInput,
  type ContainerGenerationStageRequest,
  type ContainerGenerationStageStreamRecord,
  type GenerateJobMessage,
  type GenerationExecutionContext,
  type GenerationRepairDiagnostic,
  type GenerationUsageRecord,
  type InternalApiRpc,
} from "@doxahq/contracts";
import type { AgentContainerBinding } from "@doxahq/generation";
import {
  GenerationWorkflowRunner,
  type GenerationWorkflowStep,
} from "../../agent-worker/src/generation-workflow-runtime";
import type { Env } from "../../agent-worker/src/index";
import {
  summarizeGenerationUsageRecords,
} from "../../agent-worker/src/generation-observability";
import { createVersionTreeReader } from "@doxahq/docs-engine";
import { runGenerationStage } from "../src/staged-generation";
import type { GenerationPerformanceRecord } from "../src/performance-log";
import {
  SyntheticGenerationReporter,
  type SyntheticLogEntry,
} from "./reporter";
import {
  createSyntheticScenario,
  syntheticPageContent,
  type SyntheticGenerationScenario,
  type SyntheticPageScenario,
} from "./scenario";

const execFileAsync = promisify(execFile);
const JOB_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const SITE_ID = "44444444-4444-4444-8444-444444444444";
const REPOSITORY_ID = "55555555-5555-4555-8555-555555555555";

export interface SyntheticGenerationRunOptions {
  seed?: number;
  console?: boolean;
  logFile?: string;
  keepWorkspace?: boolean;
  planStageEnabled?: boolean;
  siteConfig?: GenerationExecutionContext["siteConfig"];
  entitlements?: GenerationExecutionContext["entitlements"];
}

export interface SyntheticModelCall {
  stage: ContainerGenerationStageRequest["stage"];
  model: string;
  responseFormat: ChatRequest["responseFormat"] | null;
  toolNames: string[];
  messageCount: number;
}

export interface SyntheticGenerationRunResult {
  seed: number;
  projectName: string;
  status: "succeeded";
  versionId: string;
  pageCount: number;
  artifactKeys: string[];
  siteConfigJson: string | null;
  permanentStateKeys: string[];
  transientCheckpointKeys: string[];
  planningCheckpoints: {
    analysis: string;
    structure: string;
  };
  modelCalls: SyntheticModelCall[];
  performanceRecords: GenerationPerformanceRecord[];
  logs: SyntheticLogEntry[];
  logFile?: string;
  workspace?: string;
}

export async function runSyntheticGenerationPipeline(
  options: SyntheticGenerationRunOptions = {},
): Promise<SyntheticGenerationRunResult> {
  const scenario = createSyntheticScenario(options.seed ?? 1_729);
  const reporter = new SyntheticGenerationReporter({
    console: options.console,
    logFile: options.logFile,
  });
  const workspace = await mkdtemp(
    join(tmpdir(), `doxa-synthetic-${scenario.seed}-`),
  );
  const bucket = new MemoryR2Bucket(reporter);
  const modelCalls: SyntheticModelCall[] = [];
  const performanceRecords: GenerationPerformanceRecord[] = [];
  let api: SyntheticInternalApi | undefined;

  reporter.log("run.started", "Synthetic generation run started.", {
    seed: scenario.seed,
    projectName: scenario.projectName,
    workspace,
    logFile: options.logFile ?? null,
  });

  try {
    const repository = await createRepositoryFixture(
      workspace,
      scenario,
      reporter,
    );
    const context = {
      ...executionContext(scenario, repository),
      siteConfig: options.siteConfig,
      entitlements: options.entitlements,
    };
    api = new SyntheticInternalApi(context, reporter);
    const binding = createSyntheticContainerBinding({
      workspace,
      repositoryUrl: repository.remote,
      scenario,
      reporter,
      modelCalls,
      performanceRecords,
    });
    const env = {
      API: api as unknown as InternalApiRpc,
      GENERATION_WORKFLOW: {} as Env["GENERATION_WORKFLOW"],
      AGENT_CONTAINER: binding,
      DOCS_BUCKET: bucket as unknown as R2Bucket,
      // The synthetic models use OpenRouter-style IDs ("synthetic/planner"),
      // so the run names its provider instead of using the default.
      DOXA_MODEL_PROVIDER: "openrouter",
      OPENROUTER_API_KEY:
        "sk-or-v1-synthetic-generation-key-never-sent",
      DOXA_AGENT_PAGE_CONCURRENCY: "2",
      // Two pages per write group, so the run covers more than one write step.
      DOXA_WRITE_GROUP_SIZE: "2",
      GENERATION_IDLE_TIMEOUT_MS: "30000",
      GENERATION_OVERALL_TIMEOUT_MS: "300000",
      ANALYSIS_STAGE_TIMEOUT_MS: "120000",
      STRUCTURE_STAGE_TIMEOUT_MS: "120000",
      PAGE_BATCH_TIMEOUT_MS: "120000",
      FINALIZATION_TIMEOUT_MS: "120000",
      ...(options.planStageEnabled === false
        ? { DOXA_PLAN_STAGE_ENABLED: "0" }
        : {}),
    } satisfies Env;
    const message: GenerateJobMessage = {
      jobId: JOB_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
    };
    const step = new LoggingWorkflowStep(reporter);
    const result = await new GenerationWorkflowRunner(env).run(
      {
        payload: message,
        timestamp: new Date(),
      },
      step,
    );
    if (!("versionId" in result) || result.versionId === null) {
      throw new Error(
        `Synthetic production generation ended with ${result.outcome}.`,
      );
    }
    const allKeys = bucket.keys();
    const artifactPrefix = `sites/${SITE_ID}/versions/${result.versionId}`;
    const statePrefix =
      `sites/${SITE_ID}/generation-state/${result.versionId}`;
    // A version is a tree of blobs, so its files are logical keys.
    const versionReader = createVersionTreeReader(bucket);
    const artifactKeys =
      (await versionReader.listVersionKeys(`${artifactPrefix}/`)) ?? [];
    const permanentStateKeys = allKeys.filter((key) =>
      key.startsWith(`${statePrefix}/`)
    );
    const transientCheckpointKeys = allKeys.filter((key) =>
      key.startsWith(`_generation-checkpoints/${JOB_ID}/`)
    );
    const planningCheckpoints = bucket.planningCheckpoints();

    reporter.log(
      "workflow.completed",
      "Revision-aware workflow completed successfully.",
      {
        versionId: result.versionId,
        pageCount: scenario.pages.length,
        artifactCount: artifactKeys.length,
        permanentStateCount: permanentStateKeys.length,
      },
    );
    reporter.log("run.completed", "Synthetic generation run passed.", {
      seed: scenario.seed,
      status: api.status,
      modelRequestCount: modelCalls.length,
    });

    return {
      seed: scenario.seed,
      projectName: scenario.projectName,
      status: "succeeded",
      versionId: result.versionId,
      pageCount: scenario.pages.length,
      artifactKeys,
      siteConfigJson:
        (await (
          await versionReader.get(`${artifactPrefix}/settings/site.json`)
        )?.text()) ?? null,
      permanentStateKeys,
      transientCheckpointKeys,
      planningCheckpoints,
      modelCalls,
      performanceRecords,
      logs: reporter.entries,
      ...(options.logFile ? { logFile: options.logFile } : {}),
      ...(options.keepWorkspace ? { workspace } : {}),
    };
  } catch (error) {
    reporter.log(
      "run.failed",
      error instanceof Error ? error.message : String(error),
      {
        seed: scenario.seed,
        status: api?.status ?? "not_started",
        stack: error instanceof Error ? error.stack ?? null : null,
      },
      "error",
    );
    throw error;
  } finally {
    await reporter.flush();
    if (!options.keepWorkspace) {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

interface RepositoryFixture {
  remote: string;
  baselineRevision: string;
  targetRevision: string;
}

async function createRepositoryFixture(
  workspace: string,
  scenario: SyntheticGenerationScenario,
  reporter: SyntheticGenerationReporter,
): Promise<RepositoryFixture> {
  const repository = join(workspace, "fixture-source");
  const remote = join(workspace, "fixture-remote.git");
  await git(["init", "--initial-branch=main", repository]);
  await git(["-C", repository, "config", "user.name", "Doxa Synthetic"]);
  await git([
    "-C",
    repository,
    "config",
    "user.email",
    "synthetic@doxa.invalid",
  ]);
  await writeRepositoryFile(
    repository,
    "package.json",
    `${JSON.stringify({
      name: scenario.packageName,
      version: "1.0.0",
      type: "module",
      exports: "./src/index.ts",
    }, null, 2)}\n`,
  );
  await writeRepositoryFile(
    repository,
    "README.md",
    [
      `# ${scenario.projectName}`,
      "",
      `A small public TypeScript client for ${scenario.featureName}.`,
      "",
      "Install it with pnpm and call `createClient` from your application.",
      "",
    ].join("\n"),
  );
  await writeRepositoryFile(
    repository,
    "src/index.ts",
    [
      "export interface ClientOptions {",
      "  application: string;",
      "}",
      "",
      "export function createClient(options: ClientOptions) {",
      "  return {",
      "    async run(task: string) {",
      "      if (!task.trim()) throw new Error(\"task is required\");",
      "      return { application: options.application, task, status: \"completed\" as const };",
      "    },",
      "  };",
      "}",
      "",
    ].join("\n"),
  );
  await commitAll(repository, "baseline public client");
  const baselineRevision = await revision(repository);

  await writeRepositoryFile(
    repository,
    "src/events.ts",
    [
      "export interface OperationEvent {",
      "  task: string;",
      "  status: \"started\" | \"completed\";",
      "}",
      "",
      "export function formatOperationEvent(event: OperationEvent): string {",
      "  return `${event.task}:${event.status}`;",
      "}",
      "",
    ].join("\n"),
  );
  await writeRepositoryFile(
    repository,
    "src/index.ts",
    [
      'export { formatOperationEvent } from "./events";',
      "",
      "export interface ClientOptions {",
      "  application: string;",
      "}",
      "",
      "export function createClient(options: ClientOptions) {",
      "  return {",
      "    async run(task: string) {",
      "      if (!task.trim()) throw new Error(\"task is required\");",
      "      return { application: options.application, task, status: \"completed\" as const };",
      "    },",
      "  };",
      "}",
      "",
    ].join("\n"),
  );
  await writeRepositoryFile(
    repository,
    "README.md",
    [
      `# ${scenario.projectName}`,
      "",
      `A small public TypeScript client for ${scenario.featureName}.`,
      "",
      `Install with \`pnpm add ${scenario.packageName}\`, create a client, and await \`run\`.`,
      "Successful operations return the `completed` status.",
      "",
    ].join("\n"),
  );
  await commitAll(repository, "document observable operation events");
  const targetRevision = await revision(repository);
  await git(["clone", "--bare", repository, remote]);
  reporter.log(
    "fixture.repository.created",
    "Created a local two-revision Git repository.",
    {
      baselineRevision,
      targetRevision,
      changedFiles: ["README.md", "src/events.ts", "src/index.ts"],
    },
  );
  return { remote, baselineRevision, targetRevision };
}

function executionContext(
  scenario: SyntheticGenerationScenario,
  repository: RepositoryFixture,
): GenerationExecutionContext {
  return {
    project: {
      id: PROJECT_ID,
      name: scenario.projectName,
      slug: scenario.projectSlug,
      siteId: SITE_ID,
      siteSlug: scenario.projectSlug,
    },
    repository: {
      id: REPOSITORY_ID,
      fullName: `synthetic/${scenario.projectSlug}`,
      defaultBranch: "main",
      installationId: "synthetic-installation",
      isPrivate: true,
    },
    sourceRepository: {
      externalId: "synthetic-repository",
      owner: "synthetic",
      name: scenario.projectSlug,
    },
    job: {
      id: JOB_ID,
      trigger: "manual",
      publicationMode: "production",
      sourceProvider: null,
      sourceInstallationExternalId: null,
      changeExternalId: null,
      baselineRevision: repository.baselineRevision,
      targetRevision: repository.targetRevision,
      sourceTreeHash: null,
      baselineVersionId: null,
      agentModel: "synthetic/planner",
      plannerModel: "synthetic/planner",
      writerModel: "synthetic/writer",
      planningFingerprint: "synthetic-planning-v1",
      writingFingerprint: "synthetic-writing-v1",
      generationProfile: "fast-mvp",
      generatorFingerprint: "synthetic-generator-v1",
      externalReviewRunId: null,
    },
    changeProposal: null,
    baselineVersion: null,
    currentPreviewVersionId: null,
  };
}

interface SyntheticContainerBindingOptions {
  workspace: string;
  repositoryUrl: string;
  scenario: SyntheticGenerationScenario;
  reporter: SyntheticGenerationReporter;
  modelCalls: SyntheticModelCall[];
  performanceRecords: GenerationPerformanceRecord[];
}

function createSyntheticContainerBinding(
  options: SyntheticContainerBindingOptions,
): AgentContainerBinding {
  return {
    fetch: async (request: Request): Promise<Response> => {
      if (new URL(request.url).pathname.startsWith("/admin/containers/")) {
        options.reporter.log(
          "container.destroy.requested",
          "Synthetic container cleanup requested.",
        );
        return Response.json({ ok: true });
      }
      // Parse as the real container does, so a request it would refuse fails here too.
      const parsed = containerGenerationStageRequestSchema.safeParse(await request.json());
      if (!parsed.success) {
        return Response.json(
          { error: "Invalid generation payload.", details: parsed.error.flatten() },
          { status: 400 },
        );
      }
      const input: ContainerGenerationStageRequest = parsed.data;
      options.reporter.log(
        "stage.requested",
        `Starting ${input.stage} stage through the NDJSON transport.`,
        {
          stage: input.stage,
          stageExecutionId: input.stageExecutionId ?? null,
          model: input.model ?? null,
          pageIds: input.stage === "write" ? input.pageIds : null,
        },
      );
      const records: ContainerGenerationStageStreamRecord[] = [];
      let sequence = 0;
      try {
        const result = await runGenerationStage(
          input,
          async (type, message, data) => {
            options.reporter.log("agent.progress", message, {
              stage: input.stage,
              type,
              ...data,
            });
            records.push({
              kind: "event",
              event: {
                source: "agent",
                sequence: ++sequence,
                type,
                message,
                elapsedMs: 0,
                ...(data ? { data } : {}),
              },
            });
          },
          new AbortController(),
          {
            onUsage: (record) => {
              options.reporter.log(
                "agent.usage",
                "Captured synthetic model usage.",
                {
                  stage: record.stage,
                  operation: record.operation,
                  model: record.model,
                  totalTokens: record.totalTokens,
                  costUsd: record.costUsd,
                },
              );
              records.push({ kind: "usage", record });
            },
            onDiagnostic: (diagnostic) => {
              options.reporter.log(
                "agent.diagnostic",
                diagnostic.message,
                {
                  stage: input.stage,
                  rule: diagnostic.rule,
                  pageId: diagnostic.pageId,
                },
                "warn",
              );
              records.push({ kind: "diagnostic", diagnostic });
            },
          },
          {
            workspaceBaseDir: join(options.workspace, "container"),
            repositoryUrl: options.repositoryUrl,
            createProvider: (stageInput) =>
              createSyntheticProvider(
                stageInput,
                options.scenario,
                options.reporter,
                options.modelCalls,
              ),
            onWriterDiagnostic: (diagnostic) => {
              options.reporter.log(
                "agent.writer_diagnostic",
                `Writer gate: ${diagnostic.eventType}.`,
                {
                  stage: input.stage,
                  ...diagnostic,
                },
              );
            },
            recordPerformance: async (record) => {
              options.performanceRecords.push(record);
              options.reporter.log(
                "agent.performance",
                `Recorded ${record.summary.stage} stage performance.`,
                { ...record.summary },
              );
            },
          },
        );
        records.push({ kind: "stage_result", result });
        options.reporter.log(
          "stage.completed",
          `${input.stage} stage completed.`,
          {
            stage: input.stage,
            resultStage: result.stage,
            pageCount:
              result.stage === "write" ? result.pages.length : null,
          },
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        options.reporter.log(
          "stage.failed",
          message,
          { stage: input.stage },
          "error",
        );
        records.push({
          kind: "error",
          error: {
            message,
            retryable: false,
            code: "synthetic_stage_failure",
          },
        });
      }
      for (const record of records) {
        const parsed =
          containerGenerationStageStreamRecordSchema.safeParse(record);
        if (!parsed.success) {
          const issues = parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          }));
          options.reporter.log(
            "stage.record.invalid",
            "Synthetic stage produced a record rejected by the production stream schema.",
            {
              stage: input.stage,
              kind: record.kind,
              issues,
              record,
            },
            "error",
          );
          throw new Error(
            `Invalid ${input.stage} ${record.kind} record: ${JSON.stringify(issues)}`,
          );
        }
      }
      return new Response(
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
        {
          status: 200,
          headers: {
            "content-type": "application/x-ndjson; charset=utf-8",
          },
        },
      );
    },
  };
}

function createSyntheticProvider(
  input: ContainerGenerationStageRequest,
  scenario: SyntheticGenerationScenario,
  reporter: SyntheticGenerationReporter,
  modelCalls: SyntheticModelCall[],
): Provider {
  const config = {
    baseUrl: "synthetic://local-provider",
    apiKey: "synthetic-provider-key",
    model:
      input.model ??
      (input.stage === "write"
        ? "synthetic/writer"
        : "synthetic/planner"),
  };
  let structureCall = 0;
  let planCall = 0;
  let explorationCall = 0;

  const recordRequest = (request: ChatRequest): void => {
    const call: SyntheticModelCall = {
      stage: input.stage,
      model: request.model ?? config.model,
      responseFormat: request.responseFormat ?? null,
      toolNames: request.tools?.map((tool) => tool.function.name) ?? [],
      messageCount: request.messages.length,
    };
    modelCalls.push(call);
    reporter.log(
      "agent.model.requested",
      "Synthetic provider handled a model request.",
      {
        stage: call.stage,
        model: call.model,
        responseFormat: call.responseFormat,
        tools: call.toolNames,
        messageCount: call.messageCount,
      },
    );
  };

  const provider: Provider = {
    config,
    chat: async (request): Promise<ChatResponse> => {
      recordRequest(request);
      if (input.stage === "analysis") {
        return response(
          JSON.stringify(scenario.analysis),
          config.model,
        );
      }
      if (input.stage === "plan") {
        planCall += 1;
        if (planCall === 1) {
          return response(
            JSON.stringify(scenario.analysis),
            config.model,
          );
        }
        if (planCall === 2) {
          return response(
            JSON.stringify(scenario.structure),
            config.model,
          );
        }
        return response(
          JSON.stringify({
            decisions: structureReviewDecisions(scenario),
          }),
          config.model,
        );
      }
      if (input.stage === "structure") {
        structureCall += 1;
        if (structureCall === 1) {
          return response(
            JSON.stringify(scenario.structure),
            config.model,
          );
        }
        return response(
          JSON.stringify({
            decisions: structureReviewDecisions(scenario),
          }),
          config.model,
        );
      }

      const page = pageForRequest(scenario, request);
      const content = syntheticPageContent(scenario, page);
      const hasValidationResult = request.messages.some(
        (message) => message.role === "tool",
      );
      if (!hasValidationResult && request.tools?.some(
        (tool) => tool.function.name === "validate_page"
      )) {
        const callId = `validate-${page.id}-${request.messages.length}`;
        reporter.log(
          "agent.tool.requested",
          `Writer requested validate_page for ${page.title}.`,
          { stage: input.stage, pageId: page.id, tool: "validate_page" },
        );
        return {
          model: config.model,
          finishReason: "tool_calls",
          usage: tokenUsage(),
          message: {
            role: "assistant",
            content: null,
            toolCalls: [
              {
                id: callId,
                type: "function",
                function: {
                  name: "validate_page",
                  arguments: JSON.stringify({ content }),
                },
              },
            ],
          },
        };
      }
      return response(content, config.model);
    },
    chatStream: async function* (
      request: ChatRequest,
    ): AsyncIterable<ChatStreamEvent> {
      recordRequest(request);
      explorationCall += 1;
      if (
        (input.stage === "analysis" || input.stage === "plan") &&
        explorationCall === 1
      ) {
        const id = "explore-glob-1";
        const args = JSON.stringify({ pattern: "**/*" });
        reporter.log(
          "agent.tool.requested",
          "Repository explorer requested a file inventory.",
          { stage: input.stage, tool: "Glob", arguments: args },
        );
        yield {
          type: "tool_call_start",
          index: 0,
          id,
          name: "Glob",
        };
        yield {
          type: "tool_call_delta",
          index: 0,
          arguments: args,
        };
        yield {
          type: "done",
          finishReason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            toolCalls: [
              {
                id,
                type: "function",
                function: { name: "Glob", arguments: args },
              },
            ],
          },
        };
        return;
      }
      const text =
        `Inspected package.json, README.md, and the TypeScript public entry point. ` +
        `${scenario.projectName} exposes createClient for ${scenario.featureName}.`;
      yield { type: "text_delta", text };
      yield {
        type: "done",
        finishReason: "stop",
        message: { role: "assistant", content: text },
      };
    },
  };
  return provider;
}

function structureReviewDecisions(
  scenario: SyntheticGenerationScenario,
) {
  return scenario.structure.sections.flatMap((section) =>
    section.pages.map((page) => ({
      action: "keep" as const,
      pageId: `${section.id}/${page.id}`,
      reason:
        "The page has a distinct public reader goal backed by repository evidence.",
    }))
  );
}

function response(content: string, model: string): ChatResponse {
  return {
    model,
    finishReason: "stop",
    usage: tokenUsage(),
    message: { role: "assistant", content },
  };
}

function tokenUsage() {
  return {
    promptTokens: 12,
    completionTokens: 8,
    totalTokens: 20,
    cachedTokens: 0,
    reasoningTokens: 0,
    cost: 0,
  };
}

function pageForRequest(
  scenario: SyntheticGenerationScenario,
  request: ChatRequest,
): SyntheticPageScenario {
  // The final writing turn adds its own user message, so search every user message for the page title.
  const explicitTitle = [...request.messages]
    .reverse()
    .filter((message) => message.role === "user")
    .map((message) => /Write documentation for:\s*"([^"]+)"/.exec(message.content)?.[1])
    .find((title) => title !== undefined);
  const page = scenario.pages.find(
    (candidate) => candidate.title === explicitTitle,
  );
  if (!page) {
    throw new Error(
      `Synthetic writer could not resolve a page from prompt title ${JSON.stringify(explicitTitle)}.`,
    );
  }
  return page;
}

class LoggingWorkflowStep implements GenerationWorkflowStep {
  constructor(private readonly reporter: SyntheticGenerationReporter) {}

  async do<T>(
    name: string,
    config: unknown,
    callback: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    this.reporter.log(
      "workflow.step.started",
      name,
      { config: safeRecord(config) },
    );
    try {
      const result = await callback();
      this.reporter.log(
        "workflow.step.completed",
        name,
        { durationMs: Date.now() - startedAt },
      );
      return result;
    } catch (error) {
      this.reporter.log(
        "workflow.step.failed",
        name,
        {
          durationMs: Date.now() - startedAt,
          error:
            error instanceof Error ? error.message : String(error),
        },
        "error",
      );
      throw error;
    }
  }
}

class SyntheticInternalApi {
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "superseded" = "queued";
  readonly usageRecords: GenerationUsageRecord[] = [];
  readonly diagnostics: GenerationRepairDiagnostic[] = [];
  completion?: CompleteJobOutputInput;

  constructor(
    private readonly context: GenerationExecutionContext,
    private readonly reporter: SyntheticGenerationReporter,
  ) {}

  async getGenerationExecutionContext() {
    return this.context;
  }

  async getGenerationDatabaseCompatibility() {
    return { ready: true, missingColumns: [] };
  }

  async getGenerationControl() {
    return {
      status: "running" as const,
      reason: null,
      updatedAt: new Date().toISOString(),
    };
  }

  async markJobRunning() {
    this.status = "running";
    this.reporter.log("api.job.running", "Synthetic job marked running.");
  }

  async markJobFailed(_jobId: string, message: string) {
    this.status = "failed";
    this.reporter.log(
      "api.job.failed",
      message,
      undefined,
      "error",
    );
  }

  async markJobCancelled(_jobId: string, message: string) {
    this.status = "cancelled";
    this.reporter.log("api.job.cancelled", message, undefined, "warn");
  }

  async markJobSuperseded(_jobId: string, message: string) {
    this.status = "superseded";
    this.reporter.log(
      "api.job.superseded",
      message,
      undefined,
      "warn",
    );
  }

  async getGenerationResumedAt(): Promise<string | null> {
    return null;
  }

  async isJobActive() {
    return this.status === "queued" || this.status === "running";
  }

  async createInstallationAccessToken() {
    this.reporter.log(
      "api.installation_token.created",
      "Issued a local synthetic installation token.",
    );
    return "synthetic-installation-token-never-sent";
  }

  async createRepositoryReadToken() {
    return this.createInstallationAccessToken();
  }

  async createModelAccessToken() {
    return null;
  }

  async addJobEvent(
    _jobId: string,
    input: {
      type: string;
      message: string;
      source?: string;
      data?: Record<string, unknown>;
    },
  ) {
    this.reporter.log("api.job_event", input.message, {
      type: input.type,
      source: input.source ?? "worker",
      ...input.data,
    });
    return {
      id: crypto.randomUUID(),
      jobId: JOB_ID,
      sequence: 1,
      type: input.type,
      message: input.message,
      source: input.source ?? "worker",
      data: input.data ?? null,
      createdAt: new Date().toISOString(),
    };
  }

  async recordGenerationUsage(record: GenerationUsageRecord) {
    this.usageRecords.push(record);
    this.reporter.log(
      "api.usage.persisted",
      "Persisted a synthetic model usage record.",
      {
        stage: record.stage,
        operation: record.operation,
        model: record.model,
        totalTokens: record.totalTokens,
        costUsd: record.costUsd,
      },
    );
  }

  async recordGenerationDiagnostic(
    diagnostic: GenerationRepairDiagnostic,
    draftKey: string,
  ) {
    this.diagnostics.push(diagnostic);
    this.reporter.log(
      "api.diagnostic.persisted",
      diagnostic.message,
      { rule: diagnostic.rule, pageId: diagnostic.pageId, draftKey },
      "warn",
    );
  }

  async getGenerationUsageSummary(jobId: string) {
    return summarizeGenerationUsageRecords(jobId, this.usageRecords);
  }

  async completeJobOutput(
    _jobId: string,
    input: CompleteJobOutputInput,
  ) {
    this.completion = input;
    this.status = "succeeded";
    this.reporter.log(
      "api.job.completed",
      "Synthetic job output completed.",
      {
        versionId: input.versionId,
        publicationMode: input.publicationMode,
        regeneratedPageCount: input.regeneratedPageCount,
        reusedPageCount: input.reusedPageCount,
      },
    );
    return { versionId: input.versionId, previewUrl: null };
  }
}

interface StoredR2Value {
  bytes: Uint8Array;
  httpMetadata?: R2HTTPMetadata | Headers;
  customMetadata?: Record<string, string>;
  uploaded: Date;
}

class MemoryR2Bucket {
  private readonly values = new Map<string, StoredR2Value>();
  private readonly writes = new Map<string, StoredR2Value>();

  constructor(private readonly reporter: SyntheticGenerationReporter) {}

  keys(): string[] {
    return [...this.values.keys()].sort();
  }

  planningCheckpoints(): {
    analysis: string;
    structure: string;
  } {
    const analysis = [...this.writes.entries()].find(([key]) =>
      key.endsWith("-analysis.json")
    );
    const structure = [...this.writes.entries()].find(([key]) =>
      key.endsWith("-structure.json")
    );
    if (!analysis || !structure) {
      throw new Error(
        "Synthetic run did not write both planning checkpoints.",
      );
    }
    return {
      analysis: new TextDecoder().decode(analysis[1].bytes),
      structure: new TextDecoder().decode(structure[1].bytes),
    };
  }

  async put(
    key: string,
    value:
      | string
      | ArrayBuffer
      | ArrayBufferView
      | ReadableStream,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    const bytes = await toBytes(value);
    const stored: StoredR2Value = {
      bytes,
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
      uploaded: new Date(),
    };
    this.values.set(key, stored);
    this.writes.set(key, stored);
    this.reporter.log(
      key.startsWith("sites/")
        ? "artifact.written"
        : "checkpoint.written",
      `Wrote ${key}.`,
      { key, size: bytes.byteLength },
    );
    return r2Object(key, stored) as unknown as R2Object;
  }

  /** The version tree writer checks for a blob before it uploads it. */
  async head(key: string): Promise<R2Object | null> {
    const stored = this.values.get(key);
    return stored ? (r2Object(key, stored) as unknown as R2Object) : null;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const stored = this.values.get(key);
    if (!stored) return null;
    const copy = stored.bytes.slice();
    return {
      ...r2Object(key, stored),
      body: new Blob([copy]).stream(),
      bodyUsed: false,
      arrayBuffer: async () =>
        copy.buffer.slice(
          copy.byteOffset,
          copy.byteOffset + copy.byteLength,
        ),
      bytes: async () => copy,
      text: async () => new TextDecoder().decode(copy),
      json: async <T>() =>
        JSON.parse(new TextDecoder().decode(copy)) as T,
      blob: async () => new Blob([copy]),
    } as unknown as R2ObjectBody;
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (this.values.delete(key)) {
        this.reporter.log(
          "checkpoint.deleted",
          `Deleted ${key}.`,
          { key },
        );
      }
    }
  }

  async list(options: R2ListOptions = {}): Promise<R2Objects> {
    const prefix = options.prefix ?? "";
    const objects = this.keys()
      .filter((key) => key.startsWith(prefix))
      .map((key) => r2Object(key, this.values.get(key)!));
    return {
      objects,
      truncated: false,
      delimitedPrefixes: [],
    } as unknown as R2Objects;
  }
}

function r2Object(key: string, stored: StoredR2Value) {
  return {
    key,
    version: "synthetic",
    size: stored.bytes.byteLength,
    etag: "synthetic-etag",
    httpEtag: '"synthetic-etag"',
    checksums: {},
    uploaded: stored.uploaded,
    httpMetadata: stored.httpMetadata,
    customMetadata: stored.customMetadata,
    range: undefined,
    storageClass: "Standard",
    writeHttpMetadata: () => undefined,
  };
}

async function toBytes(
  value:
    | string
    | ArrayBuffer
    | ArrayBufferView
    | ReadableStream,
): Promise<Uint8Array> {
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
      ),
    );
  }
  return new Uint8Array(await new Response(value).arrayBuffer());
}

async function writeRepositoryFile(
  repository: string,
  path: string,
  content: string,
): Promise<void> {
  const fullPath = join(repository, path);
  await mkdir(join(fullPath, ".."), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

async function commitAll(
  repository: string,
  message: string,
): Promise<void> {
  await git(["-C", repository, "add", "--all"]);
  await git(["-C", repository, "commit", "-m", message]);
}

async function revision(repository: string): Promise<string> {
  const { stdout } = await git([
    "-C",
    repository,
    "rev-parse",
    "HEAD",
  ]);
  return stdout.trim();
}

async function git(
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    encoding: "utf8",
  }) as Promise<{ stdout: string; stderr: string }>;
}

function safeRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}
