import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { formatMdx } from "@doxahq/mdx-runtime/format";
import type { AgentUsageRecord, ChatRequest, Provider } from "../src/core";
import { generateDocumentation } from "../src/doxa-agent/generation-service";
import {
  parseSectionRepairReply,
  planSectionRepair,
  repairQualitySections,
  spliceSectionRepair,
} from "../src/doxa-agent/section-quality-repair";
import type {
  AgentConfig,
  AgentProgressEvent,
  DocsQualityIssue,
  DocumentationStructure,
} from "../src/types";

const page = [
  "---",
  "title: Overview",
  "description: Learn the public product workflow.",
  "---",
  "",
  "# Overview",
  "",
  "This public guide explains the complete product workflow for end users.",
  "",
  "## Install",
  "",
  "Consumers should edit packages/sdk/src/index.ts before using the product.",
  "",
  "```bash",
  "## a shell comment, not a heading",
  "npm install fixture",
  "```",
  "",
  "## Verify",
  "",
  "<Note>",
  "## A heading inside a component",
  "</Note>",
  "",
  "Readers confirm the workflow and verify the expected product behavior.",
  "",
].join("\n");

function issue(overrides: Partial<DocsQualityIssue>): DocsQualityIssue {
  return {
    rule: "consumer-internal-path",
    severity: "error",
    message: "Consumer docs mention repo-internal paths or test fixtures.",
    ...overrides,
  };
}

describe("section repair plan", () => {
  test("locates a body line in its h2 section past frontmatter, fences, and components", () => {
    const plan = planSectionRepair(page, [issue({ line: 7 })]);

    expect(plan?.sectionIndexes).toEqual([1]);
    expect(plan?.layout.sections.map((section) => section.heading))
      .toEqual(["Overview", "Install", "Verify"]);
    expect(plan?.head).toBe(page.slice(0, page.indexOf("# Overview")));
  });

  test("locates an issue without a line by its excerpt", () => {
    const plan = planSectionRepair(page, [
      issue({ rule: "unresolved-internal-link", excerpt: "npm install fixture" }),
    ]);

    expect(plan?.sectionIndexes).toEqual([1]);
  });

  test("has no plan for an unlocated issue, an h1 introduction issue, or every section", () => {
    expect(planSectionRepair(page, [issue({ rule: "placeholder-content" })])).toBeNull();
    expect(planSectionRepair(page, [issue({ line: 3 })])).toBeNull();
    expect(planSectionRepair("## A\n\nOne.\n\n## B\n\nTwo.", [issue({ line: 3 }), issue({ line: 7 })]))
      .toBeNull();
    expect(planSectionRepair("Lead.\n\n## A\n\nOne.", [issue({ line: 1 })])).toBeNull();
    expect(planSectionRepair(page, [issue({ line: 7 }), issue({ rule: "malformed-title" })]))
      .toBeNull();
    expect(planSectionRepair("---\ntitle: A\n---\n\n# A\n\nOnly prose.", [issue({ line: 3 })]))
      .toBeNull();
  });

  test("parses a fenced reply and splices it without touching the other sections", () => {
    // Accepted pages are already in the writer format.
    const accepted = formatMdx(page);
    const plan = planSectionRepair(accepted, [issue({ line: 7 })]);
    if (!plan) throw new Error("Expected a plan.");
    const reply = [
      "Here is the repaired section:",
      "",
      "```mdx",
      "## Install",
      "",
      "Install the public SDK in your own application.",
      "```",
    ].join("\n");

    const sections = parseSectionRepairReply(reply, 1);
    expect(sections).toEqual([
      "## Install\n\nInstall the public SDK in your own application.",
    ]);
    const spliced = spliceSectionRepair(plan, sections ?? []);

    expect(spliced).toContain("Install the public SDK in your own application.");
    expect(spliced).not.toContain("packages/sdk/src/index.ts");
    expect(spliced.startsWith(plan.head)).toBe(true);
    expect(spliced).toContain(accepted.slice(accepted.indexOf("## Verify")).trimEnd());
    expect(spliced.slice(0, spliced.indexOf("## Install")))
      .toBe(accepted.slice(0, accepted.indexOf("## Install")));
  });

  test("rejects a reply with another number of sections or extra text", () => {
    expect(parseSectionRepairReply("## A\n\nOne.\n\n## B\n\nTwo.", 1)).toBeNull();
    expect(parseSectionRepairReply("Intro prose.\n\n## A\n\nOne.", 1)).toBeNull();
    expect(parseSectionRepairReply("### A\n\nOne.", 1)).toBeNull();
  });
});

describe("repairQualitySections", () => {
  test("asks for only the affected section with the page as read-only context", async () => {
    const requests: ChatRequest[] = [];
    const outcome = await repairQualitySections({
      provider: providerWithResponses(
        ["## Install\n\nInstall the public SDK in your own application."],
        requests,
      ),
      content: page,
      issues: [issue({ line: 7, excerpt: "packages/sdk/src/index.ts" })],
      resolvedRules: new Set(["consumer-dev-script"]),
      pageId: "documentation/overview",
      pageTitle: "Overview",
      pageRetry: 1,
      validate: async () => ({ ok: true, issueCodes: [] }),
    });

    expect(outcome).toMatchObject({ ok: true, sections: ["Install"] });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools ?? []).toEqual([]);
    const prompt = requestText(requests[0]);
    const toRepair = between(prompt, "<sections-to-repair>", "</sections-to-repair>");
    expect(toRepair).toContain("packages/sdk/src/index.ts");
    expect(toRepair).not.toContain("## Verify");
    const readOnly = between(prompt, "<read-only-page>", "</read-only-page>");
    expect(readOnly).toContain("## Verify");
    expect(readOnly).toContain("[[SECTION 1 OF 1");
    expect(readOnly).not.toContain("packages/sdk/src/index.ts");
    expect(prompt).toContain("PREVIOUSLY RESOLVED RULES");
  });

  test("reports a spliced page that fails validation", async () => {
    const outcome = await repairQualitySections({
      provider: providerWithResponses(["## Install\n\nFixed."], []),
      content: page,
      issues: [issue({ line: 7 })],
      resolvedRules: new Set(),
      pageId: "documentation/overview",
      pageTitle: "Overview",
      pageRetry: 1,
      validate: async () => ({ ok: false, issueCodes: ["mdx-parse"] }),
    });

    expect(outcome).toEqual({
      ok: false,
      stage: "validation",
      reason: "spliced page failed validation: mdx-parse",
    });
  });
});

const structure: DocumentationStructure = {
  sections: [{
    id: "documentation",
    title: "Documentation",
    default: true,
    pages: [{
      id: "overview",
      title: "Overview",
      description: "Learn the public product workflow.",
    }],
  }],
};

describe("quality repair of located sections", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function generate(
    responses: readonly string[],
    requests: ChatRequest[],
    extra: Partial<AgentConfig> = {},
  ) {
    const projectRoot = await mkdtemp(join(tmpdir(), "doxa-section-repair-"));
    temporaryRoots.push(projectRoot);
    return generateDocumentation({
      cwd: projectRoot,
      toolPolicy: "read_only",
      outputDir: "generated",
      provider: providerWithResponses(responses, requests),
      concurrency: 1,
      writerValidation: { maxAttempts: 1, mdxCompile: false, timeoutMs: 1_000 },
      docsQuality: { enabled: true, maxRepairAttempts: 3, maxRepairAttemptsPerPage: 2 },
      onDocsQualityFailure: () => "retry",
      ...extra,
    }, structure);
  }

  test("repairs a located issue with one section-only model call", async () => {
    const requests: ChatRequest[] = [];
    const usage: AgentUsageRecord[] = [];
    const result = await generate(
      [page, "## Install\n\nInstall the public SDK in your own application."],
      requests,
      { onModelUsage: (record) => { usage.push(record); } },
    );

    expect(result.qualityReport?.ok).toBe(true);
    expect(requests).toHaveLength(2);
    const repairPrompt = requestText(requests[1]);
    expect(repairPrompt).toContain("SECTION QUALITY REPAIR");
    expect(repairPrompt).not.toContain("WHOLE-DOC QUALITY REPAIR");
    expect(requests[1]?.tools ?? []).toEqual([]);
    expect(between(repairPrompt, "<sections-to-repair>", "</sections-to-repair>"))
      .not.toContain("Readers confirm the workflow");
    const content = result.pages[0]?.content ?? "";
    expect(content).toContain("Install the public SDK in your own application.");
    expect(content).not.toContain("packages/sdk/src/index.ts");
    expect(content).toContain("Readers confirm the workflow and verify the expected product behavior.");
    expect(usage.at(-1)?.context).toMatchObject({
      operation: "page_write",
      pageId: "documentation/overview",
      pageRetry: 1,
    });
  });

  test("keeps the whole-page repair for an issue without a location", async () => {
    const requests: ChatRequest[] = [];
    const placeholderPage = page.replace(
      "Readers confirm the workflow",
      "TODO: Readers confirm the workflow",
    ).replace("packages/sdk/src/index.ts", "the public SDK");
    const repairedPage = placeholderPage.replace("TODO: ", "");

    const result = await generate([placeholderPage, repairedPage], requests);

    expect(result.qualityReport?.ok).toBe(true);
    expect(requests).toHaveLength(2);
    const repairPrompt = requestText(requests[1]);
    expect(repairPrompt).toContain("WHOLE-DOC QUALITY REPAIR");
    expect(repairPrompt).not.toContain("SECTION QUALITY REPAIR");
    expect(repairPrompt).toContain("CURRENT ACCEPTED DRAFT");
  });

  test("falls back to the whole-page repair when the section reply is unusable", async () => {
    const requests: ChatRequest[] = [];
    const progress: AgentProgressEvent[] = [];
    const repairedPage = page.replace(
      "Consumers should edit packages/sdk/src/index.ts before using the product.",
      "Install the public SDK in your own application.",
    );

    const projectRoot = await mkdtemp(join(tmpdir(), "doxa-section-fallback-"));
    temporaryRoots.push(projectRoot);
    const result = await generateDocumentation({
      cwd: projectRoot,
      toolPolicy: "read_only",
      outputDir: "generated",
      provider: providerWithResponses(
        [page, "## Install\n\nOne.\n\n## Extra\n\nTwo.", repairedPage],
        requests,
      ),
      concurrency: 1,
      writerValidation: { maxAttempts: 1, mdxCompile: false, timeoutMs: 1_000 },
      docsQuality: { enabled: true, maxRepairAttempts: 3, maxRepairAttemptsPerPage: 2 },
      onDocsQualityFailure: () => "retry",
    }, structure, (event) => progress.push(event));

    expect(result.qualityReport?.ok).toBe(true);
    expect(requests).toHaveLength(3);
    expect(requestText(requests[1])).toContain("SECTION QUALITY REPAIR");
    expect(requestText(requests[2])).toContain("WHOLE-DOC QUALITY REPAIR");
    expect(progress.map((event) => event.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Section repair 1\/2 fell back.*exactly 1 section/),
      ]),
    );
    expect(result.pages[0]?.content).toContain("Install the public SDK in your own application.");
  });
});

function providerWithResponses(
  responses: readonly string[],
  requests: ChatRequest[],
): Provider {
  let responseIndex = 0;
  return {
    config: { baseUrl: "https://example.test", apiKey: "test", model: "test-model" },
    chat: async (request) => {
      requests.push(request);
      const content = responses[responseIndex];
      if (content === undefined) throw new Error(`Unexpected model call ${responseIndex + 1}.`);
      responseIndex++;
      return {
        id: `generation-${responseIndex}`,
        model: "test-model",
        message: { role: "assistant", content },
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
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

function between(text: string, start: string, end: string): string {
  const from = text.lastIndexOf(start);
  const to = text.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Missing ${start} block.`);
  return text.slice(from + start.length, to);
}
