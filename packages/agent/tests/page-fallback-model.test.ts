import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const chatMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/ai")>()),
  chat: chatMock,
}));

import { generateDocumentation } from "../src/doxa-agent/generation-service";
import type { AgentConfig, DocumentationStructure } from "../src";

const temporaryRoots: string[] = [];

afterEach(async () => {
  chatMock.mockReset();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const structure: DocumentationStructure = {
  sections: [{
    id: "documentation",
    title: "Documentation",
    default: true,
    pages: [{ id: "install", title: "Install", description: "Install the package." }],
  }],
};

const page = [
  "---",
  "title: Install",
  "---",
  "",
  "Install explains a complete public workflow with concrete examples.",
  "It includes enough source-grounded detail to pass the writer validation",
  "gate while keeping this test focused on the fallback writer model.",
  "Readers can follow the steps, understand the expected result, and verify",
  "the behavior without relying on placeholders or unfinished sections.",
].join("\n");

/** The writer model is overloaded; only the fallback model answers. */
function answerOnlyFrom(model: string, models: string[]): void {
  chatMock.mockImplementation((options: { adapter: { model: string } }) => ({
    [Symbol.asyncIterator]: async function* () {
      models.push(options.adapter.model);
      if (options.adapter.model !== model) {
        yield { type: "RUN_ERROR", message: "Overloaded", code: "529" };
        return;
      }
      yield { type: "TEXT_MESSAGE_CONTENT", delta: page };
      yield { type: "RUN_FINISHED", finishReason: "stop" };
    },
  }));
}

describe("writer fallback model", () => {
  test("the last retry of a failing page uses the fallback model", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "doxa-fallback-"));
    temporaryRoots.push(projectRoot);
    const models: string[] = [];
    answerOnlyFrom("claude-sonnet-5-5", models);
    const config: AgentConfig = {
      cwd: projectRoot,
      outputDir: "generated",
      toolPolicy: "read_only",
      modelProvider: "anthropic",
      apiKey: "sk-ant-test",
      model: "claude-haiku-5-5",
      writerFallbackModel: "claude-sonnet-5-5",
      pageFailureMaxRetries: 2,
      onPageFailure: (failure) => failure.retryCount < 2 ? "retry" : "skip",
      writerValidation: { maxAttempts: 1, mdxCompile: false, timeoutMs: 1_000 },
      docsQuality: { enabled: false },
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await generateDocumentation(
      config,
      structure,
      undefined,
      undefined,
      undefined,
      undefined,
      { pageIds: ["documentation/install"], finalize: false },
    );

    expect(result.pages.map((written) => written.title)).toEqual(["Install"]);
    expect(models.at(-1)).toBe("claude-sonnet-5-5");
    expect(models.slice(0, -1).every((model) => model === "claude-haiku-5-5")).toBe(true);
  });
});
