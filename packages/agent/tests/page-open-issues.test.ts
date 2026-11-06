import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DOXABOT_INSTRUCTIONS } from "@doxahq/contracts";
import { PAGE_OPEN_ISSUE_LIMITS } from "@doxahq/contracts/generation-reviews";
import { afterEach, describe, expect, test, vi } from "vitest";

const chatMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/ai")>()),
  chat: chatMock,
}));

import { generateDocumentation } from "../src/doxa-agent/generation-service";
import type { AgentConfig, DocumentationStructure } from "../src";
import { normalizeProjectAnalysis } from "../src/utils/analysis-normalizer";
import { openIssuesOfShippedPage, pageOpenIssuesOf, softContentIssuesOfPage } from "../src/utils/page-open-issues";
import { pageInstructionRules } from "../src/utils/page-instruction-checks";
import type { ContentQualityIssue } from "../src/utils/page-validator";
import { analysisFixture } from "./fixtures";

const temporaryRoots: string[] = [];

afterEach(async () => {
  chatMock.mockReset();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function issue(check: string, message: string): ContentQualityIssue {
  return { check, message, severity: "soft", fixInstruction: "Fix it." };
}

describe("open issues of a kept page", () => {
  test("lists instruction breaks first, on one bounded line each, at most the contract limit", () => {
    const issues = [
      issue("cutoffContent", "Content appears cut off."),
      issue("instructionTerminology", `Say "repository",\nnot "repo".\u0007`),
      ...Array.from({ length: 12 }, (_, index) => issue("trailingHeading", `Heading ${index}`)),
      issue("instructionExcludedPath", "x".repeat(400)),
    ];

    const open = pageOpenIssuesOf(issues);

    expect(open).toHaveLength(PAGE_OPEN_ISSUE_LIMITS.issues);
    expect(open.slice(0, 2).map((entry) => entry.check)).toEqual(["instructionTerminology", "instructionExcludedPath"]);
    expect(open[0]).toEqual({ check: "instructionTerminology", message: 'Say "repository", not "repo".', instructions: true });
    expect(open[1]?.message.length).toBe(PAGE_OPEN_ISSUE_LIMITS.messageLength);
    expect(open[1]?.message.endsWith("…")).toBe(true);
    expect(open[2]).toEqual({ check: "cutoffContent", message: "Content appears cut off.", instructions: false });
  });

  test("a clean page has none, and an issue without text is left out", () => {
    expect(pageOpenIssuesOf([])).toEqual([]);
    expect(pageOpenIssuesOf([issue("instructionTerminology", " \n ")])).toEqual([]);
  });

  test("a page that the writer keeps with an instruction break carries the issue in the generation result", async () => {
    const page = await writeOnePage({
      title: "Install",
      body: [
        "Install the package from the repo with the package manager of your project.",
        "The steps cover the complete public workflow with concrete examples, so",
        "readers can follow them, check the expected result, and verify the",
        "behavior without placeholders or unfinished sections in the page.",
      ].join("\n"),
      instructions: { terminology: [{ use: "repository", avoid: ["repo"] }] },
    });

    expect(page?.openIssues?.map((entry) => entry.check)).toEqual(["instructionTerminology"]);
    expect(page?.openIssues?.[0]?.instructions).toBe(true);
  });

  test("the issues are found on the page as it ships, after composing added its title heading", async () => {
    const page = await writeOnePage({
      title: "Troubleshooting sign-in",
      body: [
        "Sign in with the account that your administrator created for you.",
        "Each step below shows the screen that you see, what to enter, and",
        "what happens next, so you can check every result before you move on",
        "to the next step and finish the whole workflow without guessing.",
      ].join("\n"),
      instructions: { pageTypes: ["quickstart", "guides", "reference", "concepts"] },
    });

    expect(page?.content).toContain("Troubleshooting sign-in");
    expect(page?.openIssues?.map((entry) => entry.check)).toContain("instructionPageType");
  });
});

describe("open issues of a page that a section repair changed", () => {
  const rules = pageInstructionRules({ ...DEFAULT_DOXABOT_INSTRUCTIONS, terminology: [{ use: "repository", avoid: ["repo"] }] });

  test("keep a soft content issue that the rest of the page still has", () => {
    const content = ["---", "title: Install", "---", "", "## Install", "", "Clone the repository and install the package", ""].join("\n");

    const open = openIssuesOfShippedPage({ content, rules, otherIssues: softContentIssuesOfPage(content) });

    expect(open.map((entry) => entry.check)).toEqual(["cutoffContent"]);
  });

  test("list instruction breaks of the spliced text before the other issues", () => {
    const content = ["---", "title: Install", "---", "", "## Install", "", "Clone the repo and install the package", ""].join("\n");

    const open = openIssuesOfShippedPage({ content, rules, otherIssues: softContentIssuesOfPage(content) });

    expect(open.map((entry) => entry.check)).toEqual(["instructionTerminology", "cutoffContent"]);
  });

  test("count an instruction issue once when the caller passes it too", () => {
    const content = ["---", "title: Install", "---", "", "Clone the repo.", ""].join("\n");
    const passed = issue("instructionTerminology", "Say repository.");

    const open = openIssuesOfShippedPage({ content, rules, otherIssues: [passed] });

    expect(open.filter((entry) => entry.check === "instructionTerminology")).toHaveLength(1);
  });
});

async function writeOnePage(input: {
  title: string;
  body: string;
  instructions: Partial<typeof DEFAULT_DOXABOT_INSTRUCTIONS>;
}) {
  const projectRoot = await mkdtemp(join(tmpdir(), "doxa-open-issues-"));
  temporaryRoots.push(projectRoot);
  const page = ["---", `title: ${input.title}`, "---", "", input.body].join("\n");
  chatMock.mockImplementation(() => ({
    [Symbol.asyncIterator]: async function* () {
      yield { type: "TEXT_MESSAGE_CONTENT", delta: page };
      yield { type: "RUN_FINISHED", finishReason: "stop" };
    },
  }));
  const pageId = input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const structure: DocumentationStructure = {
    sections: [{
      id: "documentation",
      title: "Documentation",
      default: true,
      pages: [{ id: pageId, title: input.title, description: `What a reader does on the ${input.title} page.` }],
    }],
  };
  const config: AgentConfig = {
    cwd: projectRoot,
    outputDir: "generated",
    toolPolicy: "read_only",
    modelProvider: "anthropic",
    apiKey: "sk-ant-test",
    model: "claude-haiku-5-5",
    writerValidation: { maxAttempts: 1, mdxCompile: false, timeoutMs: 1_000 },
    docsQuality: { enabled: false },
  };
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const result = await generateDocumentation(
    config,
    structure,
    undefined,
    {
      analysis: normalizeProjectAnalysis(analysisFixture),
      answers: {},
      structure,
      documentationBrief: {
        target: { kind: "public" },
        projectInstructions: {
          version: 2,
          instructions: { ...DEFAULT_DOXABOT_INSTRUCTIONS, ...input.instructions },
          screening: { method: "heuristic", flags: [] },
          repositoryFile: { status: "disabled" },
        },
      },
    },
    undefined,
    undefined,
    { pageIds: [`documentation/${pageId}`], finalize: false },
  );
  expect(result.pages).toHaveLength(1);
  return result.pages[0];
}
