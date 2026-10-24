import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import {
  DEFAULT_WRITER_VALIDATION,
  type DocPage,
  type DocumentationStructure,
} from "../src";
import type { ChatRequest, ChatResponse, ChatStreamEvent, Provider } from "../src/core";
import { COMPONENT_PLAYBOOK } from "../src/doxa-agent/prompts/component-playbook.generated";
import { writeDocPage } from "../src/doxa-agent/writer";
import { normalizeProjectAnalysis } from "../src/utils/analysis-normalizer";
// @ts-expect-error The sync script is plain JavaScript without declarations.
import { renderPlaybookModule } from "../scripts/sync-component-playbook.mjs";
import { analysisFixture } from "./fixtures";

const playbookSource = new URL(
  "../../../apps/docs-template/agent/component-playbook.md",
  import.meta.url,
);
const generatedModule = new URL(
  "../src/doxa-agent/prompts/component-playbook.generated.ts",
  import.meta.url,
);

class CapturingProvider implements Provider {
  readonly config = { baseUrl: "https://example.test", apiKey: "test", model: "test-model" };
  readonly requests: ChatRequest[] = [];

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    return {
      message: {
        role: "assistant",
        content: [
          "## Getting started",
          "",
          "This page explains how a reader installs the product and runs it for the first time.",
          "",
          "Each section uses the public commands of the project. ".repeat(8),
        ].join("\n"),
      },
    };
  }

  async *chatStream(_request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    return;
  }
}

const page: DocPage = {
  id: "overview",
  title: "Overview",
  description: "Understand the public product and its primary user workflows.",
};

const structure: DocumentationStructure = {
  sections: [{ id: "documentation", title: "Documentation", default: true, pages: [page] }],
};

async function writerSystemPrompt(componentPlaybook?: string): Promise<string> {
  const provider = new CapturingProvider();
  await writeDocPage(
    provider,
    process.cwd(),
    "Documentation",
    page.id,
    page,
    { analysis: normalizeProjectAnalysis(analysisFixture), answers: {}, structure },
    componentPlaybook,
    { ...DEFAULT_WRITER_VALIDATION, maxAttempts: 1, mdxCompile: false },
  );
  const system = provider.requests[0]?.messages.find((message) => message.role === "system");
  return typeof system?.content === "string" ? system.content : "";
}

describe("bundled component playbook", () => {
  test("matches apps/docs-template/agent/component-playbook.md", async () => {
    const [markdown, bundled] = await Promise.all([
      readFile(playbookSource, "utf8"),
      readFile(generatedModule, "utf8"),
    ]);

    expect(
      bundled,
      "The bundled playbook is stale. Run: node packages/agent/scripts/sync-component-playbook.mjs",
    ).toBe(renderPlaybookModule(markdown));
    expect(COMPONENT_PLAYBOOK).toBe(markdown);
  });

  test("stays about components, with nothing from the template's own repository", () => {
    for (const templateDetail of [
      "src/settings",
      "src/contents",
      "src/lib/components.ts",
      "generate:docs",
      "documents.json",
      "preferred model",
    ]) {
      expect(COMPONENT_PLAYBOOK, templateDetail).not.toContain(templateDetail);
    }
  });

  test("is appended to the writer system prompt when the caller passes none", async () => {
    const system = await writerSystemPrompt();

    expect(system).toContain("COMPONENT PLAYBOOK");
    expect(system).toContain(COMPONENT_PLAYBOOK.trim());
  });

  test("gives way to a playbook that the caller passes", async () => {
    const system = await writerSystemPrompt("CUSTOM COMPONENT REFERENCE");

    expect(system).toContain("CUSTOM COMPONENT REFERENCE");
    expect(system).not.toContain("### Steps (`Step` + `StepItem`)");
  });
});
