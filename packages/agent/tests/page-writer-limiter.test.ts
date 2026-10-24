import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { generateDocumentation } from "../src/doxa-agent/generation-service";
import { AdaptiveConcurrencyLimiter } from "../src/utils/adaptive-concurrency";
import type { ChatRequest, ChatResponse, DocumentationStructure, Provider } from "../src";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const structure: DocumentationStructure = {
  sections: [{
    id: "documentation",
    title: "Documentation",
    default: true,
    pages: Array.from({ length: 6 }, (_, index) => ({
      id: `page-${index}`,
      title: `Page ${index}`,
      description: `Documentation page ${index}.`,
    })),
  }],
};

function pageContent(title: string): string {
  return [
    "---",
    `title: ${title}`,
    "---",
    "",
    `${title} explains a complete public workflow with concrete examples.`,
    "It includes enough source-grounded detail to pass the writer validation",
    "gate while keeping this test focused on the shared writer limit.",
    "Readers can follow the steps, understand the expected result, and verify",
    "the behavior without relying on placeholders or unfinished sections.",
  ].join("\n");
}

describe("shared page writer limit", () => {
  test("no more pages call the model at once than the limiter allows", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "doxa-writer-limit-"));
    temporaryRoots.push(projectRoot);
    let running = 0;
    let peak = 0;
    const provider: Provider = {
      config: { baseUrl: "https://example.test", apiKey: "test", model: "test-model" },
      chat: async (request: ChatRequest): Promise<ChatResponse> => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        const user = request.messages.find((message) => message.role === "user")?.content ?? "";
        const title = user.match(/Write documentation for: "([^"]+)"/)?.[1] ?? "Page";
        return { message: { role: "assistant", content: pageContent(title) } };
      },
      chatStream: async function* () {
        throw new Error("Streaming is not used by this test.");
      },
    };
    const limiter = new AdaptiveConcurrencyLimiter({
      start: 2,
      min: 1,
      max: 2,
      increaseAfterSuccesses: 1,
      decreaseCooldownMs: 0,
    });

    const result = await generateDocumentation(
      {
        cwd: projectRoot,
        outputDir: "generated",
        toolPolicy: "read_only",
        provider,
        concurrency: 6,
        pageWriterLimiter: limiter,
        writerValidation: { maxAttempts: 1, mdxCompile: false, timeoutMs: 1_000 },
        docsQuality: { enabled: false },
      },
      structure,
    );

    expect(result.pages).toHaveLength(6);
    expect(peak).toBe(2);
    expect(limiter.active).toBe(0);
  });
});
