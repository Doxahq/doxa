import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildPageInputHashMap,
  generateDocumentation,
  selectGenerationTargets,
  writerFailureLogMessage,
} from "../src/doxa-agent/generation-service";
import {
  flattenStructure,
  stablePageId,
  validateGlobalPageIds,
} from "../src/doxa-agent/structure-utils";
import { PageValidationExhaustedError } from "../src/doxa-agent/writer-pipeline";
import type {
  AgentConfig,
  ChatRequest,
  ChatResponse,
  DocumentationStructure,
  Provider,
} from "../src";
import { analysisFixture, structureFixture } from "./fixtures";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function pageContent(index: number): string {
  return [
    "---",
    `title: Page ${index}`,
    "---",
    "",
    `# Page ${index}`,
    "",
    `Page ${index} explains a complete public workflow with concrete examples.`,
    "It includes enough source-grounded detail to pass the writer validation",
    "gate while keeping this test focused on scheduling and output ordering.",
    "Readers can follow the steps, understand the expected result, and verify",
    "the behavior without relying on placeholders or unfinished sections.",
  ].join("\n");
}

const fivePageStructure: DocumentationStructure = {
  sections: [{
    id: "documentation",
    title: "Documentation",
    default: true,
    pages: Array.from({ length: 5 }, (_, index) => ({
      id: `page-${index}`,
      title: `Page ${index}`,
      description: `Documentation page ${index}.`,
    })),
  }],
};

const multiSectionIdentityStructure: DocumentationStructure = {
  sections: [
    {
      id: "documentation",
      title: "Documentation",
      default: true,
      pages: [{
        id: "overview",
        title: "Overview",
        description: "Understand the public product and its primary workflows.",
      }],
    },
    {
      id: "guides",
      title: "Guides",
      pages: [{
        id: "overview",
        title: "Guide overview",
        description: "Follow task-oriented guidance for common public workflows.",
      }],
    },
    {
      id: "rest-api",
      title: "REST API",
      pages: [{
          id: "webhooks/get-webhooks",
          title: "GET /webhooks",
          description: "List webhooks available to the current public API consumer.",
          group: "Webhooks",
      }],
    },
    {
      id: "api-reference",
      title: "API Reference",
      pages: [{
        id: "client",
        title: "Client",
        description: "Use the public SDK client and its exported functions.",
      }],
    },
  ],
};

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

describe("staged page generation", () => {
  test("uses the same section-namespaced identity for validation, selection, and input hashes", () => {
    const stableIds = flattenStructure(multiSectionIdentityStructure).map(stablePageId);

    expect(stableIds).toEqual([
      "documentation/overview",
      "guides/overview",
      "rest-api/webhooks/get-webhooks",
      "api-reference/client",
    ]);
    expect(validateGlobalPageIds(multiSectionIdentityStructure)).toEqual([]);
    expect(Object.keys(buildPageInputHashMap(multiSectionIdentityStructure))).toEqual(stableIds);
    expect(
      selectGenerationTargets(multiSectionIdentityStructure, stableIds).map(stablePageId),
    ).toEqual(stableIds);
  });

  test("selects a deterministic page batch without shrinking the full structure", () => {
    const selected = selectGenerationTargets(structureFixture, [
      "default/guides/install",
      "default/overview",
    ]);

    expect(selected.map((target) => ({
      pageId: stablePageId(target),
      path: target.path,
    }))).toEqual([
      { pageId: "default/overview", path: "default/overview.md" },
      { pageId: "default/guides/install", path: "default/guides/install.md" },
    ]);
    expect(structureFixture.sections[0]?.pages).toHaveLength(3);
  });

  test("rejects unknown and duplicate requested page IDs", () => {
    expect(() => selectGenerationTargets(structureFixture, ["missing"])).toThrow(
      "Requested generation page ID was not found: missing",
    );
    expect(() => selectGenerationTargets(structureFixture, ["default/overview", "default/overview"])).toThrow(
      "Requested generation page ID is duplicated: default/overview",
    );
  });

  test("summarizes writer failures without logging generated content or debug paths", () => {
    const issue = {
      check: "body-frontmatter-artifact",
      severity: "hard" as const,
      message: "Body contains an embedded metadata block",
      fixInstruction: "Remove the embedded metadata block.",
    };
    const error = new PageValidationExhaustedError({
      title: "Overview",
      attempts: 5,
      issues: [issue],
      failedContent: "PRIVATE_GENERATED_PAGE_CONTENT",
      validationHistory: [{
        pageRetry: 0,
        attempt: 5,
        maxAttempts: 5,
        issues: [issue],
        rawContent: "PRIVATE_GENERATED_PAGE_CONTENT",
        debugPath: "/private/debug/attempt-5.md",
      }],
    });

    const message = writerFailureLogMessage("Overview", error);

    expect(message).toBe(
      'Failed to write "Overview": Page "Overview" failed validation after 5 attempts: body-frontmatter-artifact',
    );
    expect(message).not.toContain("PRIVATE_GENERATED_PAGE_CONTENT");
    expect(message).not.toContain("/private/debug");
  });

  test("keeps workers busy when an earlier page is slow and preserves structure order", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "doxa-page-pool-"));
    temporaryRoots.push(projectRoot);
    const responses = Array.from(
      { length: 5 },
      (_, index) => deferred<ChatResponse>(),
    );
    let modelCalls = 0;
    const systemPrompts: string[] = [];
    const modelCallWaiters = new Map<number, () => void>();
    const waitForModelCalls = (count: number): Promise<void> => {
      if (modelCalls >= count) return Promise.resolve();
      return new Promise((resolve) => {
        modelCallWaiters.set(count, resolve);
      });
    };
    const checkpoints = new Set<string>();
    const checkpointWaiters = new Map<string, () => void>();
    const waitForCheckpoint = (pageId: string): Promise<void> => {
      if (checkpoints.has(pageId)) return Promise.resolve();
      return new Promise((resolve) => {
        checkpointWaiters.set(pageId, resolve);
      });
    };
    const provider: Provider = {
      config: {
        baseUrl: "https://example.test",
        apiKey: "test",
        model: "test-model",
      },
      chat: async (request: ChatRequest) => {
        const isPageWrite = request.messages.some(
          (message) =>
            message.role === "user" &&
            message.content.includes("Write documentation for:"),
        );
        const systemPrompt = request.messages.find(
          (message) => message.role === "system",
        )?.content;
        if (isPageWrite && systemPrompt) systemPrompts.push(systemPrompt);
        const callIndex = modelCalls;
        modelCalls += 1;
        for (const [count, resolve] of modelCallWaiters) {
          if (modelCalls >= count) {
            modelCallWaiters.delete(count);
            resolve();
          }
        }
        const response = responses[callIndex];
        if (!response) throw new Error(`Unexpected model call ${callIndex + 1}.`);
        return response.promise;
      },
      chatStream: async function* () {
        throw new Error("Streaming is not used by this writer test.");
      },
    };
    const config: AgentConfig = {
      cwd: projectRoot,
      outputDir: "generated",
      toolPolicy: "read_only",
      provider,
      concurrency: 2,
      writerValidation: {
        maxAttempts: 1,
        mdxCompile: false,
        timeoutMs: 1_000,
      },
      docsQuality: { enabled: false },
      onPageGenerated: (page) => {
        checkpoints.add(page.id);
        checkpointWaiters.get(page.id)?.();
      },
    };

    const generation = generateDocumentation(
      config,
      fivePageStructure,
      undefined,
      {
        analysis: analysisFixture,
        answers: {},
        structure: fivePageStructure,
      },
    );
    await waitForModelCalls(2);
    expect(modelCalls).toBe(2);

    responses[1]?.resolve({
      message: { role: "assistant", content: pageContent(1) },
      finishReason: "stop",
    });
    await waitForCheckpoint("documentation/page-1");
    await waitForModelCalls(3);

    let pageFourStartedBeforePageZeroSettled = false;
    responses[2]?.resolve({
      message: { role: "assistant", content: pageContent(2) },
      finishReason: "stop",
    });
    await waitForCheckpoint("documentation/page-2");
    await waitForModelCalls(4);
    responses[3]?.resolve({
      message: { role: "assistant", content: pageContent(3) },
      finishReason: "stop",
    });
    await waitForCheckpoint("documentation/page-3");
    await waitForModelCalls(5);
    pageFourStartedBeforePageZeroSettled = modelCalls >= 5;

    responses.forEach((response, index) => {
      response.resolve({
        message: { role: "assistant", content: pageContent(index) },
        finishReason: "stop",
      });
    });
    const result = await generation;

    expect(pageFourStartedBeforePageZeroSettled).toBe(true);
    expect(result.pages.map((page) => page.id)).toEqual([
      "documentation/page-0",
      "documentation/page-1",
      "documentation/page-2",
      "documentation/page-3",
      "documentation/page-4",
    ]);
    expect(new Set(systemPrompts).size).toBe(1);
  });
});
