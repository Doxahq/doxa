/**
 * Graceful degradation keeps a page only for the owner's instructions, keeps
 * it as the model wrote it, and never makes a page worse.
 * See docs/current/doxabot-instructions.md.
 */
import { DEFAULT_DOXABOT_INSTRUCTIONS, type GenerationInstructions } from "@doxahq/contracts";
import { describe, expect, test } from "vitest";

import { DEFAULT_WRITER_VALIDATION, resolveDocumentationBrief, type WriterContext, type WriterDiagnosticEvent } from "../src";
import { splicedPageInstructions, validateSplicedPage } from "../src/doxa-agent/spliced-page-gate";
import {
  PageValidationExhaustedError,
  runWriterAttempts,
  type WriterRunResult,
} from "../src/doxa-agent/writer-pipeline";
import { listPageInstructionBreaksOfPage, pageInstructionRules } from "../src/utils/page-instruction-checks";
import { analysisFixture } from "./fixtures";

const INSTRUCTIONS = {
  ...DEFAULT_DOXABOT_INSTRUCTIONS,
  terminology: [{ use: "workspace", avoid: ["org", "team space"] }],
  doNotDocument: ["internal/**"],
} satisfies typeof DEFAULT_DOXABOT_INSTRUCTIONS;
const rules = pageInstructionRules(INSTRUCTIONS);

const COMPLETE = [
  "## Working together",
  "",
  "Each workspace has members, and every member sees the same pages.",
  "",
  "You can invite people and give them a role. A member can leave at any time.",
  "",
  "Every change shows in the activity log, so the whole team can follow what happened.",
].join("\n");

/** A body whose last line stops mid-sentence: a soft `cutoffContent` issue. */
function cutOff(tail: string): string {
  return `${COMPLETE}\n\n${tail}`;
}

interface AttemptsInput {
  answers: readonly WriterRunResult[];
  mdxCompile?: boolean;
  minBodyLength?: number;
  repaired?: string | null;
}

function runAttempts(input: AttemptsInput) {
  const warnings: string[] = [];
  const diagnostics: WriterDiagnosticEvent[] = [];
  const run = runWriterAttempts({
    title: "Teams",
    description: "How people work together in one place, and what each role can do.",
    maxAttempts: 3,
    baseTokens: 1_000,
    expandedTokens: 2_000,
    ...(input.minBodyLength ? { minBodyLength: input.minBodyLength } : {}),
    targetedRepairClasses: ["mdx", "length"],
    validation: { mdxCompile: input.mdxCompile ?? false, instructionRules: rules },
    runOnce: async ({ attempt }) => input.answers[attempt - 1] ?? input.answers.at(-1) ?? { text: "" },
    repairMdx: async () => input.repaired
      ? {
          ok: true,
          content: input.repaired,
          maxAttempts: 1,
          attempts: [{ attempt: 1, accepted: true, rejectionReason: null, validationIssueCodes: [] }],
        }
      : {
          ok: false,
          content: null,
          maxAttempts: 1,
          attempts: [{ attempt: 1, accepted: false, rejectionReason: "patch rejected", validationIssueCodes: ["mdx"] }],
        },
    saveDebug: async () => "debug-path",
    onWarn: (message) => warnings.push(message),
    onDiagnostic: (event) => diagnostics.push(event),
  });
  return { run, warnings, diagnostics };
}

describe("only instruction issues keep a page when a later attempt fails", () => {
  test("a cut-off page is not kept when the last attempt stops at the token limit", async () => {
    const { run } = runAttempts({
      answers: [
        { text: cutOff("Members who leave lose access to"), finishReason: "stop" },
        { text: COMPLETE, finishReason: "length" },
        { text: COMPLETE, finishReason: "length" },
      ],
    });

    await expect(run).rejects.toBeInstanceOf(PageValidationExhaustedError);
  });

  test("a page with an unclosed code block is not kept when an MDX repair fails", async () => {
    const unclosed = `${COMPLETE}\n\n\`\`\`ts\nconst workspace = 1;`;
    const brokenMdx = `${COMPLETE}\n\n<Callout invalid=>\nText.\n</Callout>`;
    const { run } = runAttempts({
      mdxCompile: true,
      answers: [{ text: unclosed, finishReason: "stop" }, { text: brokenMdx, finishReason: "stop" }],
      repaired: null,
    });

    await expect(run).rejects.toBeInstanceOf(PageValidationExhaustedError);
  });

  test("a page kept after a failed MDX repair on attempt 2 reports 2 attempts", async () => {
    const brokenMdx = `${COMPLETE}\n\n<Callout invalid=>\nText.\n</Callout>`;
    const { run, warnings, diagnostics } = runAttempts({
      mdxCompile: true,
      answers: [
        { text: COMPLETE.replace("Each workspace", "Each org"), finishReason: "stop" },
        { text: brokenMdx, finishReason: "stop" },
      ],
      repaired: null,
    });

    const result = await run;
    expect(result.attempts).toBe(2);
    expect(warnings.some((warning) => warning.includes("accepted after 2 attempts"))).toBe(true);
    expect(diagnostics.find((event) => event.eventType === "writer_accepted_with_issues")).toMatchObject({
      attempt: 2,
      maxAttempts: 3,
    });
  });
});

describe("a page kept after the last attempt ships as the model wrote it", () => {
  const FENCE = "```";
  const keptTails: ReadonlyArray<readonly [string, string]> = [
    ["a version number in a list item", "- Python 3.10"],
    ["a license name", "Apache-2.0 License"],
    ["a code block followed by a sentence without a final mark", `${FENCE}ts\nconst workspace = createWorkspace();\n${FENCE}\n\nRun it once per workspace`],
    ["a page cut inside a code block", `${FENCE}ts\nconst workspace = createWorkspace();\nworkspace.invite(member`],
    ["nested four-backtick fences", `${FENCE}\`md\n${FENCE}ts\nconst a = 1;\n${FENCE}\n${FENCE}\`\n\nThat is the whole file`],
  ];

  // The page composer closes a code block that the page leaves open; that is
  // formatting, not a fix, so the check is that every written line stays.
  test.each(keptTails)("%s keeps its text and gets no fix", async (_case, tail) => {
    const { run } = runAttempts({ answers: [{ text: cutOff(tail), finishReason: "stop" }] });

    const result = await run;
    expect(result.content).toContain(tail);
    expect(result.appliedFixes).toEqual([]);
    expect(result.remainingIssues.length).toBeGreaterThan(0);
  });
});

describe("a page that an MDX repair fixed keeps its body", () => {
  test("an expression the repair wrote is not escaped again", async () => {
    const short = "## Working together\n\nEach workspace has members.\n\nYou can invite people.";
    const repairedBody = `${COMPLETE.replace("Each workspace", "Each org")}\n\nA value below {"<"} 3 is invalid.`;
    const repaired = [
      "---",
      'title: "Teams"',
      'description: "How people work together in one shared place."',
      "---",
      "",
      repairedBody,
    ].join("\n");
    const { run } = runAttempts({ minBodyLength: 300, answers: [{ text: short, finishReason: "stop" }], repaired });

    const result = await run;
    expect(result.content).toContain('{"<"} 3 is invalid.');
    expect(result.content).not.toContain('\\{"<"\\}');
  });
});

describe("the section-repair gate compares each break", () => {
  const context: WriterContext = {
    analysis: analysisFixture,
    structure: { sections: [] },
    answers: {},
    documentationBrief: resolveDocumentationBrief({
      target: { kind: "public" },
      projectInstructions: {
        version: 1,
        instructions: INSTRUCTIONS,
        screening: { method: "heuristic", flags: [] },
        repositoryFile: { status: "disabled" },
      } satisfies GenerationInstructions,
    }),
  };
  const validation = { ...DEFAULT_WRITER_VALIDATION, mdxCompile: false };
  const page = (body: string) =>
    ["---", 'title: "Teams"', 'description: "How people work together in one shared place."', "---", "", body].join("\n");
  const original = page(COMPLETE.replace("Each workspace", "Each org"));

  test("one more use of an avoided term rejects the splice", async () => {
    const gate = splicedPageInstructions(context, original);
    const spliced = original.replace("You can invite people", "Each org can invite people");

    await expect(validateSplicedPage(spliced, validation, undefined, gate)).resolves.toMatchObject({ ok: false });
  });

  test("a second avoided term rejects the splice", async () => {
    const gate = splicedPageInstructions(context, original);
    const spliced = original.replace("You can invite people", "Your team space can invite people");

    await expect(validateSplicedPage(spliced, validation, undefined, gate)).resolves.toMatchObject({ ok: false });
  });

  test("fixing a term while adding an excluded path rejects the splice", async () => {
    const gate = splicedPageInstructions(context, original);
    const spliced = original
      .replace("Each org", "Each workspace")
      .replace("You can invite people", "The code in internal/secret.ts invites people");

    await expect(validateSplicedPage(spliced, validation, undefined, gate)).resolves.toMatchObject({ ok: false });
  });

  test("a splice that removes a break and adds none passes", async () => {
    const gate = splicedPageInstructions(context, original);

    await expect(validateSplicedPage(page(COMPLETE), validation, undefined, gate)).resolves.toMatchObject({ ok: true });
  });

  test("a splice that keeps the same breaks passes", async () => {
    const gate = splicedPageInstructions(context, original);
    const spliced = original.replace("You can invite people", "You can add people");

    await expect(validateSplicedPage(spliced, validation, undefined, gate)).resolves.toMatchObject({ ok: true });
  });
});

describe("the section-repair gate compares code-language breaks by count", () => {
  const languageRules = pageInstructionRules({ ...DEFAULT_DOXABOT_INSTRUCTIONS, codeLanguages: ["python", "typescript"] });
  const fence = (language: string) => ["```" + language, "x = 1", "```"].join("\n");
  const tabs = (...languages: string[]) => ["<Tabs>", ...languages.map(fence), "</Tabs>"].join("\n");
  const page = (...groups: string[]) =>
    ["---", 'title: "Teams"', 'description: "How people work together in one shared place."', "---", "", COMPLETE, "", ...groups].join("\n");
  const validation = { ...DEFAULT_WRITER_VALIDATION, mdxCompile: false };
  const gateFor = (original: string) => ({ rules: languageRules, originalBreaks: listPageInstructionBreaksOfPage(original, languageRules) });

  test("a splice that changes the languages of a group that still breaks the order passes", async () => {
    const original = page(tabs("typescript", "python"));
    const spliced = page(tabs("go", "typescript", "python"));

    await expect(validateSplicedPage(spliced, validation, undefined, gateFor(original))).resolves.toMatchObject({ ok: true });
  });

  test("a splice that adds a second group out of order is rejected", async () => {
    const original = page(tabs("typescript", "python"));
    const spliced = page(tabs("typescript", "python"), tabs("typescript", "python"));

    await expect(validateSplicedPage(spliced, validation, undefined, gateFor(original))).resolves.toMatchObject({ ok: false });
  });
});

