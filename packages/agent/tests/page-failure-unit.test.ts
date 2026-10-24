import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ModelCallError } from "../src/core";
import { generateDocumentation } from "../src/doxa-agent/generation-service";
import type {
  AgentConfig,
  ChatRequest,
  ChatResponse,
  DocumentationStructure,
  PageFailureAction,
  PageGenerationFailure,
  Provider,
} from "../src";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const structure: DocumentationStructure = {
  sections: [{
    id: "documentation",
    title: "Documentation",
    default: true,
    pages: ["install", "configure", "deploy"].map((id) => ({
      id,
      title: `Page ${id}`,
      description: `Documentation page ${id}.`,
    })),
  }],
};
const allPageIds = structure.sections[0]!.pages.map((page) => `documentation/${page.id}`);

function pageContent(title: string): string {
  return [
    "---",
    `title: ${title}`,
    "---",
    "",
    `${title} explains a complete public workflow with concrete examples.`,
    "It includes enough source-grounded detail to pass the writer validation",
    "gate while keeping this test focused on failure handling and retries.",
    "Readers can follow the steps, understand the expected result, and verify",
    "the behavior without relying on placeholders or unfinished sections.",
  ].join("\n");
}

function titleOf(request: ChatRequest): string {
  const user = request.messages.find((message) => message.role === "user")?.content ?? "";
  return user.match(/Write documentation for: "([^"]+)"/)?.[1] ?? "unknown";
}

/** Fails every call for the given titles, answers every other page. */
function providerFailing(titles: readonly string[], calls: string[]): Provider {
  return {
    config: { baseUrl: "https://example.test", apiKey: "test", model: "test-model" },
    chat: async (request: ChatRequest): Promise<ChatResponse> => {
      const title = titleOf(request);
      calls.push(title);
      if (titles.includes(title)) throw new Error("Overloaded");
      return { message: { role: "assistant", content: pageContent(title) } };
    },
    chatStream: async function* () {
      throw new Error("Streaming is not used by this test.");
    },
  };
}

const hostedLikeFailureAction = (
  failure: Pick<PageGenerationFailure, "retryCount" | "retryBudgetExhausted">,
): PageFailureAction =>
  !failure.retryBudgetExhausted && failure.retryCount < 2 ? "retry" : "skip";

async function configFor(provider: Provider): Promise<AgentConfig> {
  const projectRoot = await mkdtemp(join(tmpdir(), "doxa-page-failure-"));
  temporaryRoots.push(projectRoot);
  return {
    cwd: projectRoot,
    outputDir: "generated",
    toolPolicy: "read_only",
    provider,
    concurrency: 3,
    pageFailureMaxRetries: 2,
    pageRetryConcurrency: 3,
    onPageFailure: hostedLikeFailureAction,
    writerValidation: { maxAttempts: 1, mdxCompile: false, timeoutMs: 1_000 },
    docsQuality: { enabled: false },
  };
}

describe("a page is the unit of failure", () => {
  test("a page that keeps failing is retried, then skipped, and the other pages stay", async () => {
    const calls: string[] = [];
    const config = await configFor(providerFailing(["Page configure"], calls));

    const result = await generateDocumentation(
      config,
      structure,
      undefined,
      undefined,
      undefined,
      undefined,
      { pageIds: allPageIds, finalize: false },
    );

    expect(result.pages.map((page) => page.title)).toEqual(["Page install", "Page deploy"]);
    expect(result.skippedPages.map((failure) => failure.pageId)).toEqual([
      "documentation/configure",
    ]);
    expect(calls.filter((title) => title === "Page configure")).toHaveLength(3);
  });

  test("a batch in which every page fails ends with no pages instead of an error", async () => {
    const config = await configFor(providerFailing(
      ["Page install", "Page configure", "Page deploy"],
      [],
    ));

    const result = await generateDocumentation(
      config,
      structure,
      undefined,
      undefined,
      undefined,
      undefined,
      { pageIds: allPageIds, finalize: false },
    );

    expect(result.pages).toEqual([]);
    expect(new Set(result.skippedPages.map((failure) => failure.pageId))).toEqual(new Set(allPageIds));
  });

  test("a spend cap stops the run at once instead of retrying every page", async () => {
    const calls: string[] = [];
    const provider: Provider = {
      ...providerFailing([], calls),
      chat: async (request: ChatRequest): Promise<ChatResponse> => {
        calls.push(titleOf(request));
        throw new ModelCallError("spend_cap", "Your credit balance is too low", 400);
      },
    };
    const config = { ...(await configFor(provider)), concurrency: 1 };

    await expect(generateDocumentation(
      config,
      structure,
      undefined,
      undefined,
      undefined,
      undefined,
      { pageIds: allPageIds, finalize: false },
    )).rejects.toThrow("Model provider error (spend_cap)");
    expect(calls).toHaveLength(1);
  });

  test("a full run with no written page still fails", async () => {
    const config = await configFor(providerFailing(
      ["Page install", "Page configure", "Page deploy"],
      [],
    ));

    await expect(generateDocumentation(config, structure)).rejects.toThrow(
      "No documentation pages were generated.",
    );
  });
});
