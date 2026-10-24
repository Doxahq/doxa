import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  Provider,
} from "@doxahq/agent";
import type {
  ContainerGenerationStageRequest,
} from "@doxahq/contracts";
import { afterEach, describe, expect, test } from "vitest";
import {
  runGenerationStage,
} from "../src/staged-generation";
import type { GenerationPerformanceRecord } from "../src/performance-log";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("staged generation runtime", () => {
  test("combines analysis and structure without changing their checkpoints or events", async () => {
    const sequentialBaseDir = await mkdtemp(
      join(tmpdir(), "doxa-sequential-stage-"),
    );
    const planBaseDir = await mkdtemp(
      join(tmpdir(), "doxa-plan-stage-"),
    );
    temporaryDirectories.push(sequentialBaseDir, planBaseDir);

    const sequentialProvider = planningProvider();
    const sequentialEvents: string[] = [];
    let sequentialPreparations = 0;
    const sequentialRuntime = {
      workspaceBaseDir: sequentialBaseDir,
      createProvider: () => sequentialProvider,
      prepareWorkspace: async (
        _input: ContainerGenerationStageRequest,
        _emit: unknown,
        _abort: unknown,
        workspace: { checkoutRoot: string },
      ) => {
        sequentialPreparations += 1;
        await writeSyntheticRepository(workspace.checkoutRoot);
        return null;
      },
    };
    const analysis = await runGenerationStage(
      analysisRequest(),
      async (type) => {
        sequentialEvents.push(type);
      },
      new AbortController(),
      {},
      sequentialRuntime,
    );
    if (analysis.stage !== "analysis" || !("checkpoint" in analysis)) {
      throw new Error("Expected a successful analysis checkpoint.");
    }
    const structure = await runGenerationStage(
      {
        ...analysisRequest(),
        stage: "structure",
        analysisCheckpoint: analysis.checkpoint,
      },
      async (type) => {
        sequentialEvents.push(type);
      },
      new AbortController(),
      {},
      sequentialRuntime,
    );
    if (structure.stage !== "structure") {
      throw new Error("Expected a successful structure checkpoint.");
    }
    expect(structure.routeRegistryHash).toBe(
      "2e0e204f49c1cd668911e123e4ac55f6d7510415cdf63a17171a5ff77024bf73",
    );

    const planProvider = planningProvider();
    const planEvents: string[] = [];
    let planPreparations = 0;
    const plan = await runGenerationStage(
      {
        ...analysisRequest(),
        stage: "plan",
      } as unknown as ContainerGenerationStageRequest,
      async (type) => {
        planEvents.push(type);
      },
      new AbortController(),
      {},
      {
        workspaceBaseDir: planBaseDir,
        createProvider: () => planProvider,
        prepareWorkspace: async (
          _input,
          _emit,
          _abort,
          workspace,
        ) => {
          planPreparations += 1;
          await writeSyntheticRepository(workspace.checkoutRoot);
          return null;
        },
      },
    );

    expect(plan).toMatchObject({
      stage: "plan",
      analysisCheckpoint: analysis.checkpoint,
      structureCheckpoint: structure.checkpoint,
      pageIds: structure.pageIds,
      navigation: structure.navigation,
      pageInputHashes: structure.pageInputHashes,
      routeRegistryHash: structure.routeRegistryHash,
    });
    expect(planPreparations).toBe(1);
    expect(sequentialPreparations).toBe(2);
    expect(planEvents).toEqual(expect.arrayContaining([
      "analysis_complete",
      "structure_created",
    ]));
    expect(sequentialEvents).toEqual(expect.arrayContaining([
      "analysis_complete",
      "structure_created",
    ]));
  });

  test("uses an injected provider without contacting OpenRouter", async () => {
    const baseDir = await mkdtemp(
      join(tmpdir(), "doxa-synthetic-stage-"),
    );
    temporaryDirectories.push(baseDir);
    const calls: string[] = [];
    const events: Array<{
      type: string;
      data?: Record<string, unknown>;
    }> = [];
    const performanceRecords: GenerationPerformanceRecord[] = [];
    const provider: Provider = {
      config: {
        baseUrl: "synthetic://local",
        apiKey: "synthetic",
        model: "synthetic-planner",
      },
      chat: async (
        request: ChatRequest,
      ): Promise<ChatResponse> => {
        calls.push(request.model ?? provider.config.model);
        return {
          model: request.model,
          finishReason: "stop",
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            cost: 0,
          },
          message: {
            role: "assistant",
            content: JSON.stringify(projectAnalysis()),
          },
        };
      },
      chatStream: async function* (
        request: ChatRequest,
      ): AsyncIterable<ChatStreamEvent> {
        calls.push(request.model ?? provider.config.model);
        yield {
          type: "text_delta",
          text: "Synthetic repository exploration completed.",
        };
        yield {
          type: "done",
          finishReason: "stop",
          message: {
            role: "assistant",
            content:
              "Synthetic repository exploration completed.",
          },
        };
      },
    };

    const result = await runGenerationStage(
      analysisRequest(),
      async (type, _message, data) => {
        events.push({ type, data });
      },
      new AbortController(),
      {},
      {
        workspaceBaseDir: baseDir,
        createProvider: () => provider,
        recordPerformance: async (record) => {
          performanceRecords.push(record);
        },
        prepareWorkspace: async (_input, _emit, _abort, workspace) => {
          await mkdir(workspace.checkoutRoot, { recursive: true });
          await writeFile(
            join(workspace.checkoutRoot, "package.json"),
            `${JSON.stringify({
              name: "synthetic-library",
              version: "1.0.0",
              type: "module",
            })}\n`,
          );
          await mkdir(
            join(workspace.checkoutRoot, "src"),
            { recursive: true },
          );
          await writeFile(
            join(workspace.checkoutRoot, "src/index.ts"),
            "export const greet = (name: string) => `Hello ${name}`;\n",
          );
          return null;
        },
      },
    );

    expect(result.stage).toBe("analysis");
    expect(
      "checkpoint" in result
        ? JSON.parse(result.checkpoint).projectName
        : null,
    ).toBe("Synthetic Library");
    expect(calls).toEqual([
      "synthetic-planner",
      "synthetic-planner",
    ]);
    expect(events.some((event) => event.type === "stage_timing_summary"))
      .toBe(false);
    expect(performanceRecords).toEqual([
      expect.objectContaining({
        summary: expect.objectContaining({
          stage: "analysis",
          modelCalls: 2,
        }),
      }),
    ]);
  });

  test("emits structure_review_degraded when parseable review decisions exhaust", async () => {
    const baseDir = await mkdtemp(
      join(tmpdir(), "doxa-degraded-review-stage-"),
    );
    temporaryDirectories.push(baseDir);
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];

    const result = await runGenerationStage(
      {
        ...analysisRequest(),
        stage: "structure",
        analysisCheckpoint: JSON.stringify(projectAnalysis()),
      },
      async (type, _message, data) => {
        events.push({ type, data });
      },
      new AbortController(),
      {},
      {
        workspaceBaseDir: baseDir,
        createProvider: reviewExhaustionProvider,
        prepareWorkspace: async (_input, _emit, _abort, workspace) => {
          await writeSyntheticRepository(workspace.checkoutRoot);
          return null;
        },
      },
    );

    expect(result.stage).toBe("structure");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "structure_review_degraded",
        data: expect.objectContaining({
          unresolvedErrors: ["Structure review must provide exactly one decision for every page."],
        }),
      }),
    ]));
  });

  test("records one performance sample when a stage fails", async () => {
    const baseDir = await mkdtemp(
      join(tmpdir(), "doxa-failed-stage-"),
    );
    temporaryDirectories.push(baseDir);
    const eventTypes: string[] = [];
    const performanceRecords: GenerationPerformanceRecord[] = [];

    await expect(runGenerationStage(
      analysisRequest(),
      async (type) => {
        eventTypes.push(type);
      },
      new AbortController(),
      {},
      {
        workspaceBaseDir: baseDir,
        recordPerformance: async (record) => {
          performanceRecords.push(record);
        },
        prepareWorkspace: async () => {
          throw new Error("snapshot failed");
        },
      },
    )).rejects.toThrow("snapshot failed");

    expect(performanceRecords).toHaveLength(1);
    expect(eventTypes).not.toContain("stage_timing_summary");
  });

  test("keeps a failing performance recorder from masking the stage error", async () => {
    const baseDir = await mkdtemp(
      join(tmpdir(), "doxa-failed-perf-log-"),
    );
    temporaryDirectories.push(baseDir);

    await expect(runGenerationStage(
      analysisRequest(),
      async () => {},
      new AbortController(),
      {},
      {
        workspaceBaseDir: baseDir,
        recordPerformance: async () => {
          throw new Error("performance log unavailable");
        },
        prepareWorkspace: async () => {
          throw new Error("snapshot failed");
        },
      },
    )).rejects.toThrow("snapshot failed");
  });
});

function analysisRequest(): ContainerGenerationStageRequest {
  return {
    jobId: "11111111-1111-4111-8111-111111111111",
    stage: "analysis",
    repositoryFullName: "synthetic/library",
    defaultBranch: "main",
    installationAccessToken: "synthetic-installation-token",
    modelProvider: "openrouter",
    modelApiKey: "synthetic-openrouter-key",
    model: "synthetic-planner",
    modelConfig: {
      plannerModel: "synthetic-planner",
      writerModel: "synthetic-writer",
    },
    generationProfile: "fast-mvp",
    pageConcurrency: 2,
    maxPages: 10,
    siteId: "22222222-2222-4222-8222-222222222222",
    versionId: "33333333-3333-4333-8333-333333333333",
    projectSlug: "synthetic-library",
    projectName: "Synthetic Library",
  };
}

function planningProvider(): Provider {
  let chatCall = 0;
  return {
    config: {
      baseUrl: "synthetic://local",
      apiKey: "synthetic",
      model: "synthetic-planner",
    },
    chat: async (request): Promise<ChatResponse> => {
      chatCall += 1;
      const content = chatCall === 1
        ? projectAnalysis()
        : chatCall === 2
          ? documentationStructure()
          : structureReview();
      return {
        model: request.model,
        finishReason: "stop",
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          cost: 0,
        },
        message: {
          role: "assistant",
          content: JSON.stringify(content),
        },
      };
    },
    chatStream: async function* (
      request: ChatRequest,
    ): AsyncIterable<ChatStreamEvent> {
      yield {
        type: "text_delta",
        text: "Synthetic repository exploration completed.",
      };
      yield {
        type: "done",
        finishReason: "stop",
        message: {
          role: "assistant",
          content: "Synthetic repository exploration completed.",
        },
      };
    },
  };
}

function reviewExhaustionProvider(): Provider {
  let chatCall = 0;
  return {
    config: {
      baseUrl: "synthetic://local",
      apiKey: "synthetic",
      model: "synthetic-planner",
    },
    chat: async (request): Promise<ChatResponse> => {
      chatCall += 1;
      const content = chatCall === 1
        ? documentationStructureWithTwoPages()
        : {
            decisions: [{
              action: "keep",
              pageId: "documentation/overview",
              reason: "Incomplete review response",
            }],
          };
      return {
        model: request.model,
        finishReason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify(content),
        },
      };
    },
    chatStream: async function* (): AsyncIterable<ChatStreamEvent> {
      return;
    },
  };
}

async function writeSyntheticRepository(checkoutRoot: string): Promise<void> {
  await mkdir(checkoutRoot, { recursive: true });
  await writeFile(
    join(checkoutRoot, "package.json"),
    `${JSON.stringify({
      name: "synthetic-library",
      version: "1.0.0",
      type: "module",
    })}\n`,
  );
  await mkdir(join(checkoutRoot, "src"), { recursive: true });
  await writeFile(
    join(checkoutRoot, "src/index.ts"),
    "export const greet = (name: string) => `Hello ${name}`;\n",
  );
}

function documentationStructure() {
  return {
    sections: [
      {
        id: "documentation",
        title: "Documentation",
        default: true,
        pages: [
          {
            id: "overview",
            title: "Overview",
            description: "Learn what the library does and how to use it.",
          },
        ],
      },
    ],
  };
}

function documentationStructureWithTwoPages() {
  return {
    sections: [{
      id: "documentation",
      title: "Documentation",
      default: true,
      pages: [
        {
          id: "overview",
          title: "Overview",
          description: "Learn what the library does and how to use it.",
        },
        {
          id: "setup",
          title: "Setup",
          description: "Install and configure the library for a first successful use.",
        },
      ],
    }],
  };
}

function structureReview() {
  return {
    decisions: [
      {
        action: "keep",
        pageId: "documentation/overview",
        reason: "The overview is the required public entry point.",
      },
    ],
  };
}

function projectAnalysis() {
  return {
    projectName: "Synthetic Library",
    projectType: "library",
    languages: ["TypeScript"],
    frameworks: [],
    entryPoints: ["src/index.ts"],
    keyFiles: ["src/index.ts", "package.json"],
    summary: "A deterministic TypeScript library fixture.",
    projectDescription:
      "A deterministic TypeScript library used to exercise documentation generation.",
    projectCategory: "library",
    isMonorepo: false,
    hasReact: false,
    hasApiRoutes: false,
    hasCli: false,
    packages: [],
    cliCommands: [],
    configFiles: ["package.json"],
    apiEndpoints: [],
    keyFeatures: ["Greets a caller by name"],
    installMethods: ["pnpm add synthetic-library"],
    externalIntegrations: [],
  };
}
