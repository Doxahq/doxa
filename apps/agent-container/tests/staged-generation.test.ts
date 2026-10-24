import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  GENERATION_DIAGNOSTIC_DRAFT_MAX_CHARS,
  toJsonValue,
  type ContainerGenerationStageRequest,
  type GenerationSourceState,
  type ReusableGenerationState,
} from "@doxahq/contracts";
import type {
  AgentUsageRecord,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  DocumentationStructure,
  GeneratedPageContent,
  Provider,
  WriterRepairDiagnostic,
} from "@doxahq/agent";
import {
  buildDeterministicNavigation,
  positiveIntFromEnv,
  runGenerationStage,
  toStagedRuntimePage,
  toGenerationRepairDiagnostic,
  toGenerationUsageRecord,
  type StageEventEmitter,
} from "../src/staged-generation";
import type { HostedWorkspaceLayout } from "../src/workspace-layout";

const jobId = "11111111-1111-4111-8111-111111111111";
const stageExecutionId = "22222222-2222-4222-8222-222222222222";
const temporaryDirectories: string[] = [];

describe("staged runtime pages", () => {
  test("preserves components and fenced imports before hashing content", () => {
    const source = `---
title: Create a flag
---

<Card title="REST API">
<ApiEndpoint method="POST" path="/v1/flags">
Details
</ApiEndpoint>
</Card>

\`\`\`ts
import { FlagForgeClient } from "@flagforge/sdk";
\`\`\``;
    const page: GeneratedPageContent = {
      id: "create-flag",
      path: "/tmp/doxa-output/rest-api/create-flag/index.mdx",
      title: "Create a flag",
      content: source,
      dependencies: {
        sourceFilesRead: [],
        sourceFilesDiscovered: [],
        sourceEvidenceFiles: [],
        referencedSymbols: [],
        referencedRoutes: [],
      },
      contentHash: "old-content-hash",
      pageInputHash: "page-input-hash",
    };

    const runtimePage = toStagedRuntimePage(page, "/tmp/doxa-output");

    expect(runtimePage.content).toContain('<Card title="REST API">');
    expect(runtimePage.content).toContain(
      '<ApiEndpoint method="POST" path="/v1/flags">',
    );
    expect(runtimePage.content).toContain(
      'import { FlagForgeClient } from "@flagforge/sdk";',
    );
    expect(runtimePage.contentHash).toBe(
      createHash("sha256").update(runtimePage.content).digest("hex"),
    );
  });
});

describe("generation environment", () => {
  test.each([
    [undefined, undefined],
    ["0", undefined],
    ["-1", undefined],
    ["abc", undefined],
    ["300000", 300_000],
  ])("parses positive integer model-call budgets from %j", (configured, expected) => {
    expect(positiveIntFromEnv("DOXA_MODEL_CALL_IDLE_TIMEOUT_MS", {
      DOXA_MODEL_CALL_IDLE_TIMEOUT_MS: configured,
    })).toBe(expected);
  });

  test("uses the configured hosted workspace root instead of the process working directory", async () => {
    const configuredRoot = "/tmp/doxa-hosted-workspaces";
    const previousRoot = process.env.DOXA_WORKSPACE_ROOT;
    let observedJobRoot: string | undefined;
    process.env.DOXA_WORKSPACE_ROOT = configuredRoot;

    try {
      await expect(runGenerationStage(
        stageRequest("analysis"),
        async () => undefined,
        new AbortController(),
        {},
        {
          prepareWorkspace: async (_input, _emit, _abort, workspace) => {
            observedJobRoot = workspace.jobRoot;
            throw new Error("Stop after observing the workspace.");
          },
        },
      )).rejects.toThrow("Stop after observing the workspace.");
    } finally {
      if (previousRoot === undefined) {
        delete process.env.DOXA_WORKSPACE_ROOT;
      } else {
        process.env.DOXA_WORKSPACE_ROOT = previousRoot;
      }
    }

    expect(observedJobRoot).toBe(
      `${configuredRoot}/.workspaces/${jobId}`,
    );
  });
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

function stageRequest(stage: "analysis" | "write"): ContainerGenerationStageRequest {
  const base = {
    jobId,
    repositoryFullName: "doxa/example",
    installationAccessToken: "secret",
    modelProvider: "openrouter" as const,
    modelApiKey: "secret",
    model: stage === "write"
      ? "moonshotai/kimi-k2.6:nitro"
      : "x-ai/grok-4.5:nitro",
    modelConfig: {
      plannerModel: "x-ai/grok-4.5:nitro",
      writerModel: "moonshotai/kimi-k2.6:nitro",
    },
    stageExecutionId,
    generationProfile: "fast-mvp" as const,
    siteId: "site-1",
    versionId: "version-1",
    projectSlug: "example",
    projectName: "Example",
  };
  return stage === "analysis"
    ? { ...base, stage }
    : {
        ...base,
        stage,
        analysisCheckpoint: "{}",
        structureCheckpoint: "{}",
        pageIds: ["overview"],
      };
}

describe("staged generation navigation", () => {
  test("keeps structure order and adds deterministic groups, titles, icons, and badges", async () => {
    const navigation = await buildDeterministicNavigation({
      sections: [
        {
          id: "guide",
          title: "Guide",
          default: true,
          pages: [
            {
              id: "overview",
              title: "Overview",
              description: "Overview page",
            },
            {
              id: "overview/install",
              title: "Install",
              description: "Install page",
            },
          ],
        },
        {
          id: "api-reference",
          title: "API Reference",
          pages: [
            {
              id: "client",
              title: "Client",
              description: "Client reference",
              audience: "reference",
              reference: { kind: "sdk", exportKind: "class" },
            },
          ],
        },
      ],
    });

    expect(navigation.sections).toEqual([
      {
        slug: "default",
        items: ["default/overview.md", "default/overview/install.md"],
        groups: [
          {
            heading: "Start Here",
            items: ["default/overview.md", "default/overview/install.md"],
          },
        ],
      },
      {
        slug: "api-reference",
        items: ["api-reference/client.md"],
        groups: [
          {
            heading: "Reference",
            items: ["api-reference/client.md"],
          },
        ],
      },
    ]);
    expect(navigation.icons).toEqual({
      "default/overview.md": "compass",
      "default/overview/install.md": "package",
      "api-reference/client.md": "code",
    });
    expect(navigation.navTitles).toEqual({
      "default/overview.md": "Overview",
      "default/overview/install.md": "Install",
      "api-reference/client.md": "Client",
    });
    expect(navigation.sectionMetadata).toEqual({
      default: { label: "Guide", kind: "documentation", layout: "docs" },
      "api-reference": { label: "API Reference", kind: "reference", layout: "reference" },
    });
    expect(navigation.navBadges).toEqual({ "api-reference/client.md": "class" });
  });
});

describe("staged generation observability", () => {
  test("maps request-scoped usage to the selected Nitro model role", () => {
    const usage: AgentUsageRecord = {
      callId: "33333333-3333-4333-8333-333333333333",
      model: "moonshotai/kimi-k2.6:nitro",
      iteration: 1,
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cachedTokens: 3,
        reasoningTokens: 2,
        cost: 0.000000123456,
      },
      context: {
        operation: "page_write",
        pageId: "overview",
        pageTitle: "Overview",
        pageRetry: 0,
        attempt: 1,
      },
      recordedAt: "2026-07-25T12:00:00.000Z",
      durationMs: 125,
    };

    expect(toGenerationUsageRecord(
      stageRequest("write"),
      stageExecutionId,
      usage,
    )).toMatchObject({
      stage: "write",
      modelRole: "writer",
      model: "moonshotai/kimi-k2.6:nitro",
      costUsd: "0.000000123456",
      cachedTokens: 3,
      reasoningTokens: 2,
      pageId: "overview",
      attempt: 1,
      durationMs: 125,
    });
  });

  test("records endpoint extraction of the plan stages under the writer role", () => {
    const usage: AgentUsageRecord = {
      callId: "44444444-4444-4444-8444-444444444444",
      model: "moonshotai/kimi-k2.6:nitro",
      iteration: 1,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      context: { operation: "rest_extraction" },
      recordedAt: "2026-07-25T12:00:00.000Z",
    };

    expect(toGenerationUsageRecord(stageRequest("analysis"), stageExecutionId, usage)).toMatchObject({
      stage: "analysis",
      operation: "rest_extraction",
      modelRole: "writer",
    });
    expect(toGenerationUsageRecord(
      stageRequest("analysis"),
      stageExecutionId,
      { ...usage, context: { operation: "analysis" } },
    ).modelRole).toBe("planner");
  });

  test("preserves an unknown model-call duration as null", () => {
    const usage: AgentUsageRecord = {
      callId: "33333333-3333-4333-8333-333333333333",
      model: "moonshotai/kimi-k2.6:nitro",
      iteration: 1,
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      },
      context: {
        operation: "page_write",
        pageId: "overview",
        pageTitle: "Overview",
      },
      recordedAt: "2026-07-25T12:00:00.000Z",
    };

    expect(toGenerationUsageRecord(
      stageRequest("write"),
      stageExecutionId,
      usage,
    ).durationMs).toBeNull();
  });

  test("hashes the full failed draft while bounding the streamed copy", () => {
    const draft = "x".repeat(GENERATION_DIAGNOSTIC_DRAFT_MAX_CHARS + 5);
    const diagnostic: WriterRepairDiagnostic = {
      pageId: "overview",
      pageTitle: "Overview",
      pageRetry: 0,
      writerAttempt: 1,
      attempt: 1,
      maxAttempts: 3,
      rule: "unexpected-character",
      message: "Unexpected character",
      draft,
      repairKind: "model_patch",
      repairSucceeded: false,
      rejectionReason: "malformed-json",
      validationIssueCodes: [],
    };

    const result = toGenerationRepairDiagnostic(
      stageRequest("write"),
      stageExecutionId,
      diagnostic,
    );
    expect(result.model).toBe("moonshotai/kimi-k2.6:nitro");
    expect(result.draft).toHaveLength(GENERATION_DIAGNOSTIC_DRAFT_MAX_CHARS);
    expect(result.draftTruncated).toBe(true);
    expect(result.draftSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.writerAttempt).toBe(1);
    expect(result.maxAttempts).toBe(3);
    expect(result.rejectionReason).toBe("malformed-json");
  });
});

describe("staged structure anchoring", () => {
  test("passes the published structure and source delta to generation and review", async () => {
    const workspaceBaseDir = await mkdtemp(
      join(tmpdir(), "doxa-structure-anchor-"),
    );
    temporaryDirectories.push(workspaceBaseDir);
    const requests: ChatRequest[] = [];
    const baselineStructure = publishedStructureFixture();
    const provider = structureProvider(requests, baselineStructure);
    const previousSourceState = sourceStateFixture("a", "b");
    const currentSourceState = sourceStateFixture("c", "d");
    const reusableState = reusableStateFixture(
      previousSourceState,
      baselineStructure,
    );
    const events: Array<{
      type: string;
      data?: Record<string, unknown>;
    }> = [];

    const result = await runGenerationStage(
      {
        ...stageRequest("analysis"),
        stage: "structure",
        analysisCheckpoint: JSON.stringify(projectAnalysisFixture()),
        sourceState: currentSourceState,
        preliminaryPlan: {
          analysisMode: "full",
          structureMode: "regenerate",
          regeneratePageIds: ["overview"],
          reusePageIds: [],
          removedPageIds: [],
          modelCallsRequired: true,
          reasons: ["A structural source changed."],
        },
        structuralFingerprint: "e".repeat(64),
        planningFingerprint: "planning-v1",
        writingFingerprint: "writing-v1",
        reusableState,
      },
      async (type, _message, data) => {
        events.push({ type, data });
      },
      new AbortController(),
      {},
      {
        workspaceBaseDir,
        createProvider: () => provider,
        prepareWorkspace: async (_input, _emit, _abort, workspace) => {
          await mkdir(workspace.checkoutRoot, { recursive: true });
          await writeFile(
            join(workspace.checkoutRoot, "src-index.ts"),
            "export const current = true;\n",
          );
          return {
            outcome: "prepared",
            checkoutPath: workspace.checkoutRoot,
            snapshot: {
              targetRevision: currentSourceState.sourceRevision,
              sourceTreeHash: currentSourceState.sourceTreeHash,
              changes: [{ path: "src/index.ts", status: "modified" }],
            },
          };
        },
      },
    );

    expect(result.stage).toBe("structure");
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const userMessage = request.messages.find(
        (message) => message.role === "user",
      );
      expect(userMessage?.content).toContain("documentation/overview");
      expect(userMessage?.content).toContain("Published Overview");
      expect(userMessage?.content).toContain("src/index.ts");
    }
    expect(
      events.find((event) => event.type === "structure_created")?.data,
    ).toMatchObject({
      reason: expect.any(String),
      reusePageCount: expect.any(Number),
      regeneratePageCount: expect.any(Number),
      regenerationCauses: expect.stringMatching(
        /^new:\d+inputs:\d+deps:\d+$/,
      ),
    });
  });

  test("emits the preliminary planning reason when incremental analysis completes", async () => {
    const workspaceBaseDir = await mkdtemp(
      join(tmpdir(), "doxa-analysis-reason-"),
    );
    temporaryDirectories.push(workspaceBaseDir);
    const baselineStructure = publishedStructureFixture();
    const previousSourceState = sourceStateFixture("a", "b");
    const currentSourceState = sourceStateFixture("c", "d");
    const reusableState = reusableStateFixture(
      previousSourceState,
      baselineStructure,
    );
    const events: Array<{
      type: string;
      data?: Record<string, unknown>;
    }> = [];

    const result = await runGenerationStage(
      {
        ...stageRequest("analysis"),
        planningFingerprint: "planning-v1",
        writingFingerprint: "writing-v1",
        reusableState,
      },
      async (type, _message, data) => {
        events.push({ type, data });
      },
      new AbortController(),
      {},
      {
        workspaceBaseDir,
        createProvider: () => analysisProvider(),
        prepareWorkspace: async (_input, _emit, _abort, workspace) => {
          await mkdir(workspace.checkoutRoot, { recursive: true });
          await writeFile(
            join(workspace.checkoutRoot, "src-index.ts"),
            "export const current = true;\n",
          );
          return {
            outcome: "prepared",
            checkoutPath: workspace.checkoutRoot,
            snapshot: {
              targetRevision: currentSourceState.sourceRevision,
              sourceTreeHash: currentSourceState.sourceTreeHash,
              changes: [{ path: "src/index.ts", status: "modified" }],
            },
          };
        },
      },
    );

    expect(result.stage).toBe("analysis");
    if (result.stage !== "analysis" || !("preliminaryPlan" in result)) {
      throw new Error("Expected an incremental analysis result.");
    }
    expect(
      events.find((event) => event.type === "analysis_complete")?.data,
    ).toMatchObject({
      reason: result.preliminaryPlan?.reasons[0],
    });
  });

  test("regenerates analysis and structure when the baseline uses the prior default planning contract", async () => {
    const workspaceBaseDir = await mkdtemp(
      join(tmpdir(), "doxa-stale-planning-contract-"),
    );
    temporaryDirectories.push(workspaceBaseDir);
    const baselineStructure = publishedStructureFixture();
    const previousSourceState = sourceStateFixture("a", "b");
    const currentSourceState = sourceStateFixture("c", "d");
    const reusableState = reusableStateFixture(
      previousSourceState,
      baselineStructure,
    );
    reusableState.manifest.planningFingerprint =
      "doxa-planning-contract-v1";

    const result = await runGenerationStage(
      {
        ...stageRequest("analysis"),
        reusableState,
      },
      async () => {},
      new AbortController(),
      {},
      {
        workspaceBaseDir,
        createProvider: () => analysisProvider(),
        prepareWorkspace: async (_input, _emit, _abort, workspace) => {
          await mkdir(workspace.checkoutRoot, { recursive: true });
          await writeFile(
            join(workspace.checkoutRoot, "src-index.ts"),
            "export const current = true;\n",
          );
          return {
            outcome: "prepared",
            checkoutPath: workspace.checkoutRoot,
            snapshot: {
              targetRevision: currentSourceState.sourceRevision,
              sourceTreeHash: currentSourceState.sourceTreeHash,
              changes: [{ path: "src/index.ts", status: "modified" }],
            },
          };
        },
      },
    );

    expect(result.stage).toBe("analysis");
    if (result.stage !== "analysis" || !("preliminaryPlan" in result)) {
      throw new Error("Expected an incremental analysis result.");
    }
    expect(result.preliminaryPlan).toMatchObject({
      analysisMode: "full",
      structureMode: "regenerate",
      reasons: ["The documentation planning contract changed."],
    });
  });

  test("builds the repository map once per snapshot tree and serves it from the process cache", async () => {
    const baselineStructure = publishedStructureFixture();
    // A tree hash no other test uses: the map cache lives for the whole process.
    const currentSourceState = sourceStateFixture("e", "f");
    const runFullAnalysis = async () => {
      const workspaceBaseDir = await mkdtemp(join(tmpdir(), "doxa-repo-map-stage-"));
      temporaryDirectories.push(workspaceBaseDir);
      const reusableState = reusableStateFixture(sourceStateFixture("a", "b"), baselineStructure);
      reusableState.manifest.planningFingerprint = "doxa-planning-contract-v1";
      const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
      const explorationSystemPrompts: string[] = [];
      const provider = analysisProvider();
      const streamExploration = provider.chatStream.bind(provider);
      provider.chatStream = (request) => {
        explorationSystemPrompts.push(String(request.messages[0]?.content ?? ""));
        return streamExploration(request);
      };

      await runGenerationStage(
        { ...stageRequest("analysis"), reusableState },
        async (type, _message, data) => {
          events.push({ type, data });
        },
        new AbortController(),
        {},
        {
          workspaceBaseDir,
          createProvider: () => provider,
          prepareWorkspace: async (_input, _emit, _abort, workspace) => {
            await mkdir(join(workspace.checkoutRoot, "src"), { recursive: true });
            await writeFile(
              join(workspace.checkoutRoot, "src/index.ts"),
              "export function createClient() {}\n",
            );
            return {
              outcome: "prepared",
              checkoutPath: workspace.checkoutRoot,
              snapshot: {
                targetRevision: currentSourceState.sourceRevision,
                sourceTreeHash: currentSourceState.sourceTreeHash,
                changes: [{ path: "src/index.ts", status: "modified" }],
              },
            };
          },
        },
      );
      return { events, explorationSystemPrompts };
    };

    const first = await runFullAnalysis();
    const second = await runFullAnalysis();

    const mapEvent = (run: typeof first) => run.events.find((event) => event.type.startsWith("repo_map_"));
    expect(mapEvent(first)).toEqual({
      type: "repo_map_ready",
      data: expect.objectContaining({
        cacheHit: false,
        sourceFileCount: 1,
        symbolCount: 1,
        areaCount: 1,
        tokenEstimate: expect.any(Number),
        durationMs: expect.any(Number),
      }),
    });
    expect(mapEvent(second)?.data).toMatchObject({ cacheHit: true, sourceFileCount: 1 });
    expect(first.explorationSystemPrompts[0]).toContain("REPOSITORY MAP");
    expect(first.explorationSystemPrompts[0]).toContain("createClient");
    const mapBlock = (prompt: string) => prompt.slice(prompt.indexOf("REPOSITORY MAP"));
    expect(mapBlock(second.explorationSystemPrompts[0])).toBe(mapBlock(first.explorationSystemPrompts[0]));
  });
});

describe("staged generation workspace isolation", () => {
  test("one write-stage cleanup cannot delete another execution's artifacts", async () => {
    const workspaceBaseDir = await mkdtemp(
      join(tmpdir(), "doxa-stage-isolation-"),
    );
    temporaryDirectories.push(workspaceBaseDir);

    let prepareCallCount = 0;
    let bothPreparedResolve: () => void = () => undefined;
    const bothPrepared = new Promise<void>((resolve) => {
      bothPreparedResolve = resolve;
    });
    let releaseSecondResolve: () => void = () => undefined;
    const releaseSecond = new Promise<void>((resolve) => {
      releaseSecondResolve = resolve;
    });

    const prepareWorkspace = async (
      _input: ContainerGenerationStageRequest,
      _emitEvent: StageEventEmitter,
      _abortController: AbortController,
      workspace: HostedWorkspaceLayout,
    ) => {
      prepareCallCount += 1;
      const call = prepareCallCount;
      await mkdir(workspace.artifactRoot, { recursive: true });
      const marker = join(workspace.artifactRoot, `request-${call}.txt`);
      await writeFile(marker, "active\n");

      if (prepareCallCount === 2) bothPreparedResolve();
      await bothPrepared;
      if (call === 1) {
        throw new Error("first stage stopped after preparation");
      }

      await releaseSecond;
      await access(marker);
      throw new Error("second stage stopped after isolation check");
    };
    const firstInput = stageRequest("write");
    const secondInput = {
      ...stageRequest("write"),
      stageExecutionId: "33333333-3333-4333-8333-333333333333",
    };
    const emitEvent = async (): Promise<void> => undefined;

    const first = runGenerationStage(
      firstInput,
      emitEvent,
      new AbortController(),
      {},
      { workspaceBaseDir, prepareWorkspace },
    );
    const second = runGenerationStage(
      secondInput,
      emitEvent,
      new AbortController(),
      {},
      { workspaceBaseDir, prepareWorkspace },
    );

    await expect(first).rejects.toThrow(
      "first stage stopped after preparation",
    );
    releaseSecondResolve();
    await expect(second).rejects.toThrow(
      "second stage stopped after isolation check",
    );
  });
});

function publishedStructureFixture(): DocumentationStructure {
  return {
    sections: [
      {
        id: "documentation",
        title: "Documentation",
        default: true,
        pages: [
          {
            id: "overview",
            title: "Published Overview",
            description:
              "Understand the published product and its primary public workflows.",
          },
        ],
      },
    ],
  };
}

function projectAnalysisFixture() {
  return {
    projectName: "Example",
    projectType: "library",
    languages: ["TypeScript"],
    frameworks: [],
    entryPoints: ["src/index.ts"],
    keyFiles: ["src/index.ts"],
    summary: "A deterministic library fixture.",
    projectDescription:
      "A deterministic library fixture used for structure-stage tests.",
    projectCategory: "library",
    isMonorepo: false,
    hasReact: false,
    hasApiRoutes: false,
    hasCli: false,
    packages: [],
    cliCommands: [],
    configFiles: [],
    apiEndpoints: [],
    keyFeatures: ["Exports a public value"],
    installMethods: ["pnpm add example"],
    externalIntegrations: [],
  };
}

function sourceStateFixture(
  treeCharacter: string,
  contentCharacter: string,
): GenerationSourceState {
  return {
    schemaVersion: 1,
    sourceRevision: treeCharacter.repeat(40),
    sourceTreeHash: treeCharacter.repeat(40),
    files: [
      {
        path: "src/index.ts",
        contentHash: contentCharacter.repeat(64),
        contentKind: "text",
      },
    ],
  };
}

function reusableStateFixture(
  source: GenerationSourceState,
  structure: DocumentationStructure,
): ReusableGenerationState {
  const objectHash = "a".repeat(64);
  return {
    manifest: {
      schemaVersion: 1,
      siteId: "site-1",
      versionId: "version-1",
      baselineVersionId: null,
      generatorFingerprint: "generator-v1",
      planningFingerprint: "planning-v1",
      writingFingerprint: "writing-v1",
      sourceRevision: source.sourceRevision,
      sourceTreeHash: source.sourceTreeHash,
      source: { key: "state/source.json", hash: objectHash },
      analysis: { key: "state/analysis.json", hash: objectHash },
      structure: { key: "state/structure.json", hash: objectHash },
      pages: [],
      createdAt: "2026-07-31T00:00:00.000Z",
    },
    source,
    analysis: {
      schemaVersion: 1,
      analysis: toJsonValue(projectAnalysisFixture()),
      analysisHash: objectHash,
      sourceSummaries: [],
    },
    structure: {
      schemaVersion: 1,
      structure: toJsonValue(structure),
      structureHash: objectHash,
      structuralFingerprint: objectHash,
    },
    pages: [],
  };
}

function structureProvider(
  requests: ChatRequest[],
  structure: DocumentationStructure,
): Provider {
  let call = 0;
  return {
    config: {
      baseUrl: "synthetic://local",
      apiKey: "synthetic",
      model: "synthetic-planner",
    },
    async chat(request): Promise<ChatResponse> {
      requests.push(request);
      call += 1;
      return {
        message: {
          role: "assistant",
          content: JSON.stringify(
            call === 1
              ? structure
              : {
                  decisions: [
                    {
                      action: "keep",
                      pageId: "documentation/overview",
                      reason: "Public entry point.",
                    },
                  ],
                },
          ),
        },
      };
    },
    async *chatStream(
      _request: ChatRequest,
    ): AsyncIterable<ChatStreamEvent> {
      return;
    },
  };
}

function analysisProvider(): Provider {
  return {
    config: {
      baseUrl: "synthetic://local",
      apiKey: "synthetic",
      model: "synthetic-planner",
    },
    async chat(): Promise<ChatResponse> {
      return {
        message: {
          role: "assistant",
          content: JSON.stringify(projectAnalysisFixture()),
        },
      };
    },
    async *chatStream(): AsyncIterable<ChatStreamEvent> {
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
