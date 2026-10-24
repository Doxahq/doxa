import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatRequest, Provider } from "../src/core";
import { PageGenerationAbortedError } from "../src/doxa-agent/errors";
import { generateDocumentation } from "../src/doxa-agent/generation-service";
import type {
  AgentConfig,
  AgentProgressEvent,
  DocumentationStructure,
} from "../src/types";

const qualityValidationTracker = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../src/utils/docs-quality-validator", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/utils/docs-quality-validator")
  >();
  return {
    ...actual,
    validateGeneratedDocs: (...args: Parameters<typeof actual.validateGeneratedDocs>) => {
      qualityValidationTracker.calls++;
      return actual.validateGeneratedDocs(...args);
    },
  };
});

const structure: DocumentationStructure = {
  sections: [
    {
      id: "documentation",
      title: "Documentation",
      default: true,
      pages: [
        {
          id: "overview",
          title: "Overview",
          description: "Learn the public product workflow.",
        },
      ],
    },
  ],
};

const threePageStructure: DocumentationStructure = {
  sections: [{
    id: "documentation",
    title: "Documentation",
    default: true,
    pages: ["alpha", "bravo", "charlie"].map((id) => ({
      id,
      title: titleCase(id),
      description: `Learn the public ${id} workflow.`,
    })),
  }],
};

const invalidPage = [
  "---",
  "title: Overview",
  "---",
  "",
  "# Overview",
  "",
  "This public guide explains the complete product workflow for end users.",
  "It deliberately remains long enough to pass the writer content gate while",
  "repeating a deterministic whole-document quality violation on every repair.",
  "Consumers should edit packages/sdk/src/index.ts before using the product.",
  "The remaining prose describes a stable workflow, expected outcomes, and",
  "practical guidance without placeholders or unfinished sections.",
].join("\n");

const flagforgeStructure: DocumentationStructure = {
  sections: [
    {
      id: "documentation",
      title: "Documentation",
      default: true,
      pages: [
        {
          id: "packages/flagforge-monorepo",
          title: "flagforge monorepo",
          description: "Explain how consumers use the analyzed FlagForge surface.",
          group: "Packages",
          collectionId: "packages",
          collectionItemId: "packages/flagforge-monorepo",
        },
      ],
    },
  ],
};

function completePage(title: string, body: string): string {
  return [
    "---",
    `title: ${title}`,
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
    "This guide includes enough complete, source-grounded explanation for the",
    "writer validation gate while keeping the test focused on docs quality.",
    "Readers can follow the workflow and verify the expected product behavior.",
  ].join("\n");
}

function providerWithResponses(
  responses: readonly string[],
  requests: ChatRequest[],
): Provider {
  let responseIndex = 0;
  return {
    config: {
      baseUrl: "https://example.test",
      apiKey: "test",
      model: "test-model",
    },
    chat: async (request) => {
      requests.push(request);
      const content = responses[responseIndex];
      if (!content) throw new Error(`Unexpected model call ${responseIndex + 1}.`);
      responseIndex++;
      return {
        id: `generation-${responseIndex}`,
        model: "test-model",
        message: { role: "assistant", content },
        finishReason: "stop",
      };
    },
    chatStream: async function* () {
      throw new Error("Streaming is not used by the legacy writer.");
    },
  };
}

function requestText(request: ChatRequest | undefined): string {
  return (request?.messages ?? [])
    .map((message) => typeof message.content === "string" ? message.content : "")
    .join("\n");
}

describe("whole-document quality repair", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    qualityValidationTracker.calls = 0;
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  test("generates one round of independent page repairs concurrently", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "doxa-quality-parallel-"));
    temporaryRoots.push(projectRoot);
    let repairsInFlight = 0;
    let maximumRepairsInFlight = 0;
    const provider = repairProvider({
      repairDelayMs: () => 20,
      onRepairStarted: () => {
        repairsInFlight++;
        maximumRepairsInFlight = Math.max(
          maximumRepairsInFlight,
          repairsInFlight,
        );
      },
      onRepairFinished: () => {
        repairsInFlight--;
      },
    });

    const result = await generateDocumentation({
      cwd: projectRoot,
      toolPolicy: "read_only",
      outputDir: "generated",
      provider,
      concurrency: 3,
      writerValidation: {
        maxAttempts: 1,
        mdxCompile: false,
        timeoutMs: 1_000,
      },
      docsQuality: {
        enabled: true,
        maxRepairAttempts: 3,
        maxRepairAttemptsPerPage: 1,
      },
      onDocsQualityFailure: () => "retry",
    }, threePageStructure, undefined, undefined, undefined, undefined, {
      finalize: false,
    });

    expect(result.qualityReport?.ok).toBe(true);
    expect(maximumRepairsInFlight).toBeGreaterThanOrEqual(2);
    expect(qualityValidationTracker.calls).toBe(5);
  });

  test("accepts repair candidates in stable page order despite shuffled completion", async () => {
    const first = await runThreePageRepair({
      alpha: 30,
      bravo: 20,
      charlie: 10,
    });
    const second = await runThreePageRepair({
      alpha: 10,
      bravo: 20,
      charlie: 30,
    });

    expect(first.pages.map(({ id, content }) => ({ id, content }))).toEqual(
      second.pages.map(({ id, content }) => ({ id, content })),
    );
    expect(first.failedPages.map(({ pageId, reason }) => ({ pageId, reason })))
      .toEqual(
        second.failedPages.map(({ pageId, reason }) => ({ pageId, reason })),
      );
  });

  test("rejects a candidate that fixes its page rule but breaks a cross-page link", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "doxa-quality-link-"));
    temporaryRoots.push(projectRoot);
    const progressEvents: AgentProgressEvent[] = [];
    const responses = new Map([
      ["Alpha", invalidConsumerPage("Alpha")],
      ["Bravo", validConsumerPage("Bravo")],
    ]);
    const repair = validConsumerPage(
      "Alpha",
      "Continue with [the Bravo workflow](/bravoo).",
    );
    const provider: Provider = {
      config: {
        baseUrl: "https://example.test",
        apiKey: "test",
        model: "test-model",
      },
      chat: async (request) => {
        const title = writerRequestTitle(request);
        const isRepair = requestText(request).includes(
          "WHOLE-DOC QUALITY REPAIR",
        );
        const content = isRepair ? repair : responses.get(title);
        if (!content) {
          throw new Error(`No writer response configured for ${title}.`);
        }
        return {
          id: `generation-${title}-${isRepair ? "repair" : "initial"}`,
          model: "test-model",
          message: {
            role: "assistant",
            content,
          },
          finishReason: "stop",
        };
      },
      chatStream: async function* () {
        throw new Error("Streaming is not used by the legacy writer.");
      },
    };
    const linkStructure: DocumentationStructure = {
      sections: [{
        id: "documentation",
        title: "Documentation",
        default: true,
        pages: ["alpha", "bravo"].map((id) => ({
          id,
          title: titleCase(id),
          description: `Learn the public ${id} workflow.`,
        })),
      }],
    };

    await expect(
      generateDocumentation({
        cwd: projectRoot,
        toolPolicy: "read_only",
        outputDir: "generated",
        provider,
        concurrency: 2,
        writerValidation: {
          maxAttempts: 1,
          mdxCompile: false,
          timeoutMs: 1_000,
        },
        docsQuality: {
          enabled: true,
          maxRepairAttempts: 1,
          maxRepairAttemptsPerPage: 1,
        },
        onDocsQualityFailure: () => "retry",
      }, linkStructure, (event) => {
        progressEvents.push(event);
      }, undefined, undefined, undefined, {
        finalize: false,
      }),
    ).rejects.toThrow("exhausted the quality repair budget after 1 repairs");

    expect(progressEvents.map((event) => event.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /repair candidate 1\/1 rejected.*unresolved-internal-link/i,
        ),
      ]),
    );
    expect(
      await readFile(join(projectRoot, "generated", "default", "alpha.md"), "utf8"),
    ).toContain("packages/sdk/src/index.ts");
  });

  test("retries the same quality-failed page up to its dedicated budget", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "doxa-quality-repair-"));
    temporaryRoots.push(projectRoot);
    let modelCalls = 0;
    let writerFailureDecisions = 0;
    let docsQualityFailureDecisions = 0;
    const progressEvents: AgentProgressEvent[] = [];
    const provider: Provider = {
      config: {
        baseUrl: "https://example.test",
        apiKey: "test",
        model: "test-model",
      },
      chat: async () => {
        modelCalls++;
        return {
          id: `generation-${modelCalls}`,
          model: "test-model",
          message: { role: "assistant", content: invalidPage },
          finishReason: "stop",
        };
      },
      chatStream: async function* () {
        throw new Error("Streaming is not used by the legacy writer.");
      },
    };
    const config: AgentConfig = {
      cwd: projectRoot,
      toolPolicy: "read_only",
      outputDir: "generated",
      provider,
      concurrency: 1,
      writerValidation: {
        maxAttempts: 1,
        mdxCompile: false,
        timeoutMs: 1_000,
      },
      pageFailureMaxRetries: 1,
      onPageFailure: (failure) => {
        writerFailureDecisions++;
        return failure.retryCount < 1 ? "retry" : "abort";
      },
      docsQuality: {
        enabled: true,
        maxRepairAttempts: 3,
        maxRepairAttemptsPerPage: 2,
      },
      onDocsQualityFailure: () => {
        docsQualityFailureDecisions++;
        return "retry";
      },
    };

    const generation = generateDocumentation(
      config,
      structure,
      (event) => progressEvents.push(event),
    );

    await expect(generation).rejects.toMatchObject({
      name: PageGenerationAbortedError.name,
      failure: {
        pageId: "documentation/overview",
        retryCount: 2,
        reason: expect.stringContaining("quality repair budget exhausted"),
      },
    });
    expect(modelCalls).toBe(3);
    expect(writerFailureDecisions).toBe(0);
    // Two repair decisions, then one at the exhausted budget, where only skip or abort remain.
    expect(docsQualityFailureDecisions).toBe(3);
    expect(progressEvents.map((event) => event.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Quality repair 1\/2 for Overview.*global repair 1\/3.*consumer-internal-path/i),
        expect.stringMatching(/Quality repair 2\/2 for Overview.*global repair 2\/3.*consumer-internal-path/i),
      ]),
    );
  });

  test("skips a page whose quality repairs ran out when the handler allows it", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "doxa-quality-skip-"));
    temporaryRoots.push(projectRoot);
    const provider: Provider = {
      config: { baseUrl: "https://example.test", apiKey: "test", model: "test-model" },
      chat: async () => ({
        model: "test-model",
        message: { role: "assistant", content: invalidPage },
        finishReason: "stop",
      }),
      chatStream: async function* () {
        throw new Error("Streaming is not used by the legacy writer.");
      },
    };
    const config: AgentConfig = {
      cwd: projectRoot,
      toolPolicy: "read_only",
      outputDir: "generated",
      provider,
      concurrency: 1,
      writerValidation: { maxAttempts: 1, mdxCompile: false, timeoutMs: 1_000 },
      docsQuality: { enabled: true, maxRepairAttempts: 3, maxRepairAttemptsPerPage: 2 },
      onDocsQualityFailure: (failure) => failure.retryBudgetExhausted ? "skip" : "retry",
    };

    const result = await generateDocumentation(
      config,
      structure,
      undefined,
      undefined,
      undefined,
      undefined,
      { pageIds: ["documentation/overview"], finalize: false },
    );

    expect(result.pages).toEqual([]);
    expect(result.skippedPages).toEqual([
      expect.objectContaining({
        pageId: "documentation/overview",
        retryBudgetExhausted: true,
        reason: expect.stringContaining("quality repair budget exhausted"),
      }),
    ]);
  });

  /**
   * PRODUCTION INCIDENT REGRESSION GUARDRAIL
   * Generation c2a531c5 exposed a stateless repair loop. Fix production
   * behavior when this fails; do not weaken the expectations to get green.
   */
  test("gives the model the accepted draft and every blocking issue", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "doxa-quality-draft-"));
    temporaryRoots.push(projectRoot);
    const requests: ChatRequest[] = [];
    const initialDraft = completePage(
      "Overview",
      [
        "Consumers should edit packages/sdk/src/index.ts before using the product.",
        "Run pnpm dev to start the contributor workspace.",
      ].join("\n"),
    );
    const repairedDraft = completePage(
      "Overview",
      "Consumers install the public SDK and initialize it in their own application.",
    );
    const provider = providerWithResponses([initialDraft, repairedDraft], requests);
    const checkpointedDrafts: string[] = [];

    const result = await generateDocumentation({
      cwd: projectRoot,
      toolPolicy: "read_only",
      outputDir: "generated",
      provider,
      concurrency: 1,
      writerValidation: {
        maxAttempts: 1,
        mdxCompile: false,
        timeoutMs: 1_000,
      },
      docsQuality: {
        enabled: true,
        maxRepairAttempts: 3,
        maxRepairAttemptsPerPage: 2,
      },
      onDocsQualityFailure: () => "retry",
      onPageGenerated: (page) => {
        checkpointedDrafts.push(page.content);
      },
    }, structure);

    expect(result.qualityReport?.ok).toBe(true);
    expect(checkpointedDrafts).toHaveLength(2);
    const acceptedInitialDraft = checkpointedDrafts[0];
    expect(acceptedInitialDraft).toBeDefined();
    if (!acceptedInitialDraft) throw new Error("Initial draft was not checkpointed.");
    const repairPrompt = requestText(requests[1]);
    expect(repairPrompt).toContain("CURRENT ACCEPTED DRAFT");
    expect(repairPrompt).toContain(acceptedInitialDraft);
    expect(repairPrompt).toContain("consumer-internal-path");
    expect(repairPrompt).toContain("packages/sdk/src/index.ts");
    expect(repairPrompt).toContain("consumer-dev-script");
    expect(repairPrompt).toContain("pnpm dev");
  });

  /**
   * PRODUCTION INCIDENT REGRESSION GUARDRAIL
   * Preserve the last accepted draft when a repair swaps or reintroduces a
   * hard rule. Fix production behavior when this fails; never bless oscillation.
   */
  test("rejects oscillating repairs without overwriting the accepted FlagForge page", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "doxa-quality-oscillation-"));
    temporaryRoots.push(projectRoot);
    const requests: ChatRequest[] = [];
    const progressEvents: AgentProgressEvent[] = [];
    const checkpointedDrafts: string[] = [];
    const initialDraft = completePage(
      "flagforge monorepo",
      [
        "The repository layout contains:",
        "",
        "```text",
        "flagforge/",
        "├── packages/",
        "```",
        "",
        "Run pnpm dev to start the contributor workspace.",
      ].join("\n"),
    );
    const treeRemovedDraft = completePage(
      "flagforge monorepo",
      "Run pnpm dev to start the contributor workspace before using FlagForge.",
    );
    const reintroducedTree = completePage(
      "flagforge monorepo",
      "The source tree still contains:\n\n```text\nflagforge/\n├── packages/\n```",
    );
    const provider = providerWithResponses(
      [initialDraft, treeRemovedDraft, reintroducedTree],
      requests,
    );

    let thrown: unknown;
    try {
      await generateDocumentation({
        cwd: projectRoot,
        toolPolicy: "read_only",
        outputDir: "generated",
        provider,
        concurrency: 1,
        writerValidation: {
          maxAttempts: 1,
          mdxCompile: false,
          timeoutMs: 1_000,
        },
        docsQuality: {
          enabled: true,
          maxRepairAttempts: 3,
          maxRepairAttemptsPerPage: 2,
        },
        onDocsQualityFailure: () => "retry",
        onPageGenerated: (page) => {
          checkpointedDrafts.push(page.content);
        },
      }, flagforgeStructure, (event) => {
        progressEvents.push(event);
      }, undefined, undefined, undefined, {
        pageIds: ["documentation/packages/flagforge-monorepo"],
        finalize: false,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PageGenerationAbortedError);
    if (!(thrown instanceof PageGenerationAbortedError)) {
      throw new Error("Expected generation to abort after exhausting quality repairs.");
    }
    expect(thrown).toMatchObject({
      failure: {
        pageId: "documentation/packages/flagforge-monorepo",
        retryCount: 2,
        reason: expect.stringContaining("consumer-dev-script"),
      },
    });
    expect(checkpointedDrafts).toHaveLength(2);
    const acceptedDraft = checkpointedDrafts[1];
    expect(acceptedDraft).toBeDefined();
    if (!acceptedDraft) throw new Error("Improved FlagForge draft was not checkpointed.");
    expect(acceptedDraft).toContain("pnpm dev");
    expect(acceptedDraft).not.toContain("├── packages/");
    expect(thrown.generatedPages).toEqual([
      expect.objectContaining({ content: acceptedDraft }),
    ]);
    const generatedPagePath = thrown.generatedPages[0]?.path;
    expect(generatedPagePath).toBeDefined();
    if (!generatedPagePath) throw new Error("Accepted FlagForge page path is missing.");
    expect(await readFile(generatedPagePath, "utf8")).toBe(acceptedDraft);
    expect(progressEvents.map((event) => event.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/repair candidate 2\/2 rejected.*consumer-internal-path/i),
      ]),
    );

    const secondRepairPrompt = requestText(requests[2]);
    expect(secondRepairPrompt).toContain("CURRENT ACCEPTED DRAFT");
    expect(secondRepairPrompt).toContain(acceptedDraft);
    expect(secondRepairPrompt).toContain("PREVIOUSLY RESOLVED RULES");
    expect(secondRepairPrompt).toContain("consumer-internal-path");
  });

  /**
   * PRODUCTION INCIDENT REGRESSION GUARDRAIL
   * A writer-invalid quality candidate must stay inside the quality-repair
   * budget and must never escape through the separate page-failure policy.
   */
  test("keeps writer-invalid repair candidates inside the quality-repair loop", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "doxa-quality-writer-invalid-"));
    temporaryRoots.push(projectRoot);
    const requests: ChatRequest[] = [];
    const progressEvents: AgentProgressEvent[] = [];
    let pageFailureDecisions = 0;
    const initialDraft = completePage(
      "Overview",
      "Consumers should edit packages/sdk/src/index.ts before using the product.",
    );
    const writerInvalidCandidate = "---\ntitle: Overview\n---\n\nToo short.";
    const validCandidate = completePage(
      "Overview",
      "Consumers install the public SDK and initialize it in their own application.",
    );
    const provider = providerWithResponses(
      [initialDraft, writerInvalidCandidate, validCandidate],
      requests,
    );

    const result = await generateDocumentation({
      cwd: projectRoot,
      toolPolicy: "read_only",
      outputDir: "generated",
      provider,
      concurrency: 1,
      writerValidation: {
        maxAttempts: 1,
        mdxCompile: false,
        timeoutMs: 1_000,
      },
      pageFailureMaxRetries: 1,
      onPageFailure: () => {
        pageFailureDecisions++;
        return "retry";
      },
      docsQuality: {
        enabled: true,
        maxRepairAttempts: 3,
        maxRepairAttemptsPerPage: 2,
      },
      onDocsQualityFailure: () => "retry",
    }, structure, (event) => {
      progressEvents.push(event);
    });

    expect(result.qualityReport?.ok).toBe(true);
    expect(pageFailureDecisions).toBe(0);
    expect(progressEvents.map((event) => event.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/repair candidate 1\/2 rejected.*writer validation/i),
        expect.stringMatching(/Quality repair 2\/2 for Overview/i),
      ]),
    );
    const secondRepairPrompt = requestText(requests[2]);
    expect(secondRepairPrompt).toContain("PREVIOUS REJECTED CANDIDATE");
    expect(secondRepairPrompt).toContain("writer validation");
    expect(secondRepairPrompt).toContain("CURRENT ACCEPTED DRAFT");
  });
});

async function runThreePageRepair(
  repairDelays: Record<"alpha" | "bravo" | "charlie", number>,
) {
  const projectRoot = await mkdtemp(join(tmpdir(), "doxa-quality-order-"));
  const provider = repairProvider({
    repairDelayMs: (title) =>
      repairDelays[title.toLowerCase() as keyof typeof repairDelays],
  });

  try {
    return await generateDocumentation({
      cwd: projectRoot,
      toolPolicy: "read_only",
      outputDir: "generated",
      provider,
      concurrency: 3,
      writerValidation: {
        maxAttempts: 1,
        mdxCompile: false,
        timeoutMs: 1_000,
      },
      docsQuality: {
        enabled: true,
        maxRepairAttempts: 3,
        maxRepairAttemptsPerPage: 1,
      },
      onDocsQualityFailure: () => "retry",
    }, threePageStructure, undefined, undefined, undefined, undefined, {
      finalize: false,
    });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

function repairProvider(options: {
  repairDelayMs(title: string): number;
  onRepairStarted?: () => void;
  onRepairFinished?: () => void;
}): Provider {
  return {
    config: {
      baseUrl: "https://example.test",
      apiKey: "test",
      model: "test-model",
    },
    chat: async (request) => {
      const title = writerRequestTitle(request);
      const isRepair = requestText(request).includes(
        "WHOLE-DOC QUALITY REPAIR",
      );
      if (isRepair) {
        options.onRepairStarted?.();
        await new Promise((resolve) =>
          setTimeout(resolve, options.repairDelayMs(title))
        );
        options.onRepairFinished?.();
      }
      return {
        id: `generation-${title}-${isRepair ? "repair" : "initial"}`,
        model: "test-model",
        message: {
          role: "assistant",
          content: isRepair
            ? validConsumerPage(title)
            : invalidConsumerPage(title),
        },
        finishReason: "stop",
      };
    },
    chatStream: async function* () {
      throw new Error("Streaming is not used by the legacy writer.");
    },
  };
}

function writerRequestTitle(request: ChatRequest): string {
  const match = requestText(request).match(/Write documentation for: "([^"]+)"/);
  if (!match?.[1]) {
    throw new Error("Writer request title is missing.");
  }
  return match[1];
}

function invalidConsumerPage(title: string): string {
  return validConsumerPage(
    title,
    "Consumers should edit packages/sdk/src/index.ts before using the product.",
  );
}

function validConsumerPage(
  title: string,
  body = "Consumers install the public SDK and initialize it in their application.",
): string {
  return completePage(title, body);
}

function titleCase(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
