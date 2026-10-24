import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  MemoryArtifactStore,
  MemoryStateStore,
  createDoxaAgent,
  type AgentConfig,
  type ChatRequest,
  type ChatResponse,
  type DocumentationStructure,
  type Provider,
  type SourceChangeSet,
  type WorkspaceAdapter,
} from "../src";
import { DEFAULT_WRITER_MAX_STEPS } from "../src/doxa-agent/constants";
import { generateDocumentation } from "../src/doxa-agent/generation-service";
import { prompts } from "../src/doxa-agent/prompts";
import { analysisFixture, structureFixture } from "./fixtures";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

function workspace(
  sourceChanges: SourceChangeSet = { changedFiles: [], addedFiles: [], deletedFiles: [] },
): WorkspaceAdapter {
  return {
    async readText() {
      return "";
    },
    async listFiles() {
      return [];
    },
    async grep() {
      return [];
    },
    async hashFile() {
      return null;
    },
    async hashFiles() {
      return {};
    },
    async getSourceChanges() {
      return sourceChanges;
    },
    async createCheckpoint() {
      return {
        generatedAt: new Date().toISOString(),
        headCommitHash: null,
        defaultBranch: null,
        defaultBranchCommitHash: null,
        dirtyFileHashes: {},
        deletedFiles: [],
      };
    },
  };
}

describe("DoxaAgent generation", () => {
  test("writes pages, persists manifest, and reuses cached pages", async () => {
    const state = new MemoryStateStore({ structure: structureFixture });
    await state.saveAnalysisState({
      analysis: analysisFixture,
      explorationContext: "fixture",
      sourceCheckpoint: null,
      updatedAt: new Date().toISOString(),
    });
    const artifacts = new MemoryArtifactStore({ "stale.mdx": "# Stale\n" });
    let writes = 0;

    const agent = createDoxaAgent({
      workspace: workspace(),
      state,
      artifacts,
      handlers: {
        writePage: async ({ target }) => {
          writes++;
          return {
            content: `# ${target.title}\n`,
            sourceFilesRead: target.sourceEvidence.map((evidence) => evidence.path),
          };
        },
      },
    });

    const first = await agent.generateDocs();
    expect(first.pages).toHaveLength(3);
    expect(writes).toBe(3);
    expect(await artifacts.readText("stale.mdx")).toBeNull();
    expect((await state.loadDocsManifest())?.pages).toHaveLength(3);

    const second = await agent.generateDocs();
    expect(second.pages).toHaveLength(3);
    expect(writes).toBe(3);
  });

  test("regenerates only pages affected by source changes", async () => {
    const state = new MemoryStateStore({ structure: structureFixture });
    await state.saveAnalysisState({
      analysis: analysisFixture,
      explorationContext: "fixture",
      sourceCheckpoint: null,
      updatedAt: new Date().toISOString(),
    });
    const artifacts = new MemoryArtifactStore();
    let writes = 0;

    const firstAgent = createDoxaAgent({
      workspace: workspace(),
      state,
      artifacts,
      handlers: {
        writePage: async ({ target }) => {
          writes++;
          return {
            content: `# ${target.title}\n`,
            sourceFilesRead: target.sourceEvidence.map((evidence) => evidence.path),
          };
        },
      },
    });
    await firstAgent.generateDocs();

    const secondAgent = createDoxaAgent({
      workspace: workspace({ changedFiles: ["src/index.ts"], addedFiles: [], deletedFiles: [] }),
      state,
      artifacts,
      handlers: {
        writePage: async ({ target }) => {
          writes++;
          return {
            content: `# Updated ${target.title}\n`,
            sourceFilesRead: target.sourceEvidence.map((evidence) => evidence.path),
          };
        },
      },
    });

    const result = await secondAgent.generateDocs();
    expect(writes).toBe(4);
    expect(result.pages.find((page) => page.id === "overview")?.content).toBe("# Updated Overview\n");
    expect(result.pages.find((page) => page.id === "guides")?.content).toBe("# Guides\n");
  });
});

describe("writer exploration", () => {
  test("keeps validation-only prompt fallbacks evidence-grounded", () => {
    const structured = prompts.buildWriterPrompt({
      analysis: analysisFixture,
      sectionTitle: "Documentation",
      page: evidenceStructure.sections[0]!.pages[0]!,
      structure: evidenceStructure,
      relevantContext: "",
      sourceEvidenceContext: "",
      writerExplorationMode: "validation_only",
    });
    const generic = prompts.buildGenericWriterPrompt({
      title: "Client",
      description: "Create and configure the public client.",
      relevantContext: "",
      sourceEvidenceContext: "",
      writerExplorationMode: "validation_only",
    });

    expect(structured.user).not.toMatch(/explor(?:e|ation)/i);
    expect(generic.user).not.toMatch(/explor(?:e|ation)/i);
  });

  test("uses one validation-only model call for a sufficient evidence bundle", async () => {
    const requests: ChatRequest[] = [];
    const resolvedModes: string[] = [];
    const project = await evidenceProject();

    await generateDocumentation(
      {
        ...writerConfig(project, providerReturningPage(requests), "evidence_first"),
        onWriterExplorationResolved: ({ mode }) => resolvedModes.push(mode),
      },
      evidenceStructure,
      undefined,
      writerContext(),
    );

    expect(requests).toHaveLength(1);
    expect(toolNames(requests[0])).toEqual(["validate_page"]);
    const userMessage = requests[0]?.messages.find(
      (message) => message.role === "user",
    )?.content;
    expect(userMessage).not.toContain("Explore the codebase");
    expect(userMessage).toContain(
      "Ground every claim in the SOURCE EVIDENCE block below",
    );
    expect(resolvedModes).toEqual(["evidence_first"]);
  });

  test("falls back to the full agentic tool surface when evidence is insufficient", async () => {
    const requests: ChatRequest[] = [];
    const resolvedModes: string[] = [];
    const project = await emptyProject();

    await generateDocumentation(
      {
        ...writerConfig(project, providerReturningPage(requests), "evidence_first"),
        onWriterExplorationResolved: ({ mode }) => resolvedModes.push(mode),
      },
      {
        sections: [{
          ...evidenceStructure.sections[0]!,
          pages: [{
            ...evidenceStructure.sections[0]!.pages[0]!,
            sourceEvidence: [],
            reference: undefined,
          }],
        }],
      },
      undefined,
      writerContext(),
    );

    expect(requests).toHaveLength(1);
    expect(toolNames(requests[0])).toEqual([
      "Read",
      "Glob",
      "Grep",
      "validate_page",
    ]);
    expect(resolvedModes).toEqual(["agentic_fallback"]);
  });

  test("keeps the current agentic behavior when writer exploration is unset", async () => {
    const requests: ChatRequest[] = [];
    const project = await evidenceProject();

    await generateDocumentation(
      writerConfig(project, providerReturningPage(requests)),
      evidenceStructure,
      undefined,
      writerContext(),
    );

    expect(requests).toHaveLength(1);
    expect(toolNames(requests[0])).toEqual([
      "Read",
      "Glob",
      "Grep",
      "validate_page",
    ]);
  });

  test("reserves two steps for evidence-first writing and the default cap for agentic fallback", async () => {
    const evidenceRequests: ChatRequest[] = [];
    const evidenceProjectRoot = await evidenceProject();
    await generateDocumentation(
      writerConfig(
        evidenceProjectRoot,
        providerDrivingToStepBudget(evidenceRequests),
        "evidence_first",
      ),
      evidenceStructure,
      undefined,
      writerContext(),
    );

    const fallbackRequests: ChatRequest[] = [];
    const fallbackProjectRoot = await emptyProject();
    await generateDocumentation(
      writerConfig(
        fallbackProjectRoot,
        providerDrivingToStepBudget(fallbackRequests),
        "evidence_first",
      ),
      {
        sections: [{
          ...evidenceStructure.sections[0]!,
          pages: [{
            ...evidenceStructure.sections[0]!.pages[0]!,
            sourceEvidence: [],
            reference: undefined,
          }],
        }],
      },
      undefined,
      writerContext(),
    );

    expect(evidenceRequests).toHaveLength(2);
    expect(toolNames(evidenceRequests[0])).toEqual(["validate_page"]);
    expect(toolNames(evidenceRequests[1])).toEqual([]);
    expect(DEFAULT_WRITER_MAX_STEPS).toBe(8);
    expect(fallbackRequests).toHaveLength(DEFAULT_WRITER_MAX_STEPS);
    expect(toolNames(fallbackRequests[0])).toEqual([
      "Read",
      "Glob",
      "Grep",
      "validate_page",
    ]);
    expect(toolNames(fallbackRequests[DEFAULT_WRITER_MAX_STEPS - 1])).toEqual([]);
  });

  test("caps agentic writer steps with the configured writerMaxSteps", async () => {
    const requests: ChatRequest[] = [];
    const project = await emptyProject();

    await generateDocumentation(
      {
        ...writerConfig(project, providerDrivingToStepBudget(requests)),
        writerMaxSteps: 4,
      },
      evidenceStructure,
      undefined,
      writerContext(),
    );

    expect(requests).toHaveLength(4);
    expect(toolNames(requests[2])).toContain("validate_page");
    expect(toolNames(requests[3])).toEqual([]);
    expect(requestText(requests[3])).toContain("research budget");
  });

  test("keeps two steps for evidence-first writing when writerMaxSteps is set", async () => {
    const requests: ChatRequest[] = [];
    const project = await evidenceProject();

    await generateDocumentation(
      {
        ...writerConfig(project, providerDrivingToStepBudget(requests), "evidence_first"),
        writerMaxSteps: 5,
      },
      evidenceStructure,
      undefined,
      writerContext(),
    );

    expect(requests).toHaveLength(2);
  });

  test("rejects a writerMaxSteps that leaves no turn before the final one", async () => {
    const project = await emptyProject();

    await expect(
      generateDocumentation(
        {
          ...writerConfig(project, providerReturningPage([])),
          writerMaxSteps: 1,
        },
        evidenceStructure,
        undefined,
        writerContext(),
      ),
    ).rejects.toThrow("writerMaxSteps must be an integer of at least 2");
  });
});

const evidenceStructure: DocumentationStructure = {
  sections: [{
    id: "documentation",
    title: "Documentation",
    default: true,
    pages: [{
      id: "client",
      title: "Client",
      description: "Create and configure the public client.",
      sourceEvidence: [{ path: "src/client.ts", kind: "source" }],
      reference: {
        kind: "sdk",
        moduleId: "client",
        exportId: "create-client",
      },
    }],
  }],
};

function writerConfig(
  cwd: string,
  provider: Provider,
  writerExploration?: AgentConfig["writerExploration"],
): AgentConfig {
  return {
    cwd,
    outputDir: "generated",
    toolPolicy: "read_only",
    provider,
    concurrency: 1,
    writerExploration,
    writerValidation: {
      maxAttempts: 1,
      mdxCompile: false,
      timeoutMs: 1_000,
    },
    docsQuality: { enabled: false },
  };
}

function writerContext() {
  return {
    analysis: {
      ...analysisFixture,
      referenceSurfaces: {
        sdk: {
          sourceEvidence: [],
          modules: [{
            id: "client",
            title: "Client",
            sourceEvidence: [{ path: "src/client.ts", kind: "source" as const }],
            exports: [{
              id: "create-client",
              name: "createClient",
              kind: "function" as const,
              description: "Create a public client.",
              sourceEvidence: [{
                path: "src/client.ts",
                kind: "source" as const,
              }],
            }],
          }],
        },
      },
    },
    answers: {},
    structure: evidenceStructure,
  };
}

function providerReturningPage(requests: ChatRequest[]): Provider {
  return {
    config: {
      baseUrl: "https://example.test",
      apiKey: "test",
      model: "test-model",
    },
    async chat(request): Promise<ChatResponse> {
      requests.push(request);
      return {
        message: {
          role: "assistant",
          content: validPage(),
        },
        finishReason: "stop",
      };
    },
    async *chatStream() {
      throw new Error("Streaming is not used by this test.");
    },
  };
}

function providerDrivingToStepBudget(requests: ChatRequest[]): Provider {
  let toolCall = 0;
  return {
    config: {
      baseUrl: "https://example.test",
      apiKey: "test",
      model: "test-model",
    },
    async chat(request): Promise<ChatResponse> {
      requests.push(request);
      if (request.tools?.length) {
        toolCall += 1;
        return {
          message: {
            role: "assistant",
            content: null,
            toolCalls: [{
              id: `validation-${toolCall}`,
              type: "function",
              function: {
                name: "validate_page",
                arguments: JSON.stringify({
                  content: `${validPage()}\n\nValidation pass ${toolCall}.`,
                }),
              },
            }],
          },
          finishReason: "tool_calls",
        };
      }
      return {
        message: {
          role: "assistant",
          content: validPage(),
        },
        finishReason: "stop",
      };
    },
    async *chatStream() {
      throw new Error("Streaming is not used by this test.");
    },
  };
}

function requestText(request: ChatRequest | undefined): string {
  return (request?.messages ?? [])
    .map((message) => typeof message.content === "string" ? message.content : "")
    .join("\n");
}

function toolNames(request: ChatRequest | undefined): string[] {
  return request?.tools?.map((tool) => tool.function.name) ?? [];
}

function validPage(): string {
  return [
    "---",
    "title: Client",
    "description: Create and configure the public client.",
    "---",
    "",
    "# Client",
    "",
    "Create a client with repository-backed settings and verify the result.",
    "This guide explains the supported public workflow with enough detail for",
    "readers to configure the client and confirm that it behaves as expected.",
  ].join("\n");
}

async function evidenceProject(): Promise<string> {
  const directory = await emptyProject();
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(
    join(directory, "src", "client.ts"),
    "export function createClient() { return {}; }\n",
    "utf8",
  );
  return directory;
}

async function emptyProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "doxa-writer-exploration-"));
  temporaryDirectories.push(directory);
  return directory;
}
