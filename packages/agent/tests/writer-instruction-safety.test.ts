/**
 * The writer keeps a page that only breaks the owner's instructions, and no
 * repair path skips those checks. See docs/current/doxabot-instructions.md.
 */
import { DEFAULT_DOXABOT_INSTRUCTIONS, type GenerationInstructions } from "@doxahq/contracts";
import { describe, expect, test } from "vitest";

import type { AgentLoopReport, WriterContext, WriterDiagnosticEvent } from "../src";
import { DEFAULT_WRITER_VALIDATION } from "../src";
import { orderRequestClientsByLanguage, restEndpointReferenceOptions } from "../src/doxa-agent/rest-endpoint-page";
import { splicedPageInstructions, validateSplicedPage } from "../src/doxa-agent/spliced-page-gate";
import {
  PageValidationExhaustedError,
  runWriterAttempts,
  type WriterRunResult,
} from "../src/doxa-agent/writer-pipeline";
import { pageInstructionRules } from "../src/utils/page-instruction-checks";
import { resolveDocumentationBrief } from "../src";
import { analysisFixture } from "./fixtures";

const STRICT = {
  ...DEFAULT_DOXABOT_INSTRUCTIONS,
  codeLanguages: ["python", "typescript"],
  terminology: [{ use: "workspace", avoid: ["org"] }],
  pageTypes: ["quickstart", "guides", "concepts"],
} satisfies typeof DEFAULT_DOXABOT_INSTRUCTIONS;
const rules = pageInstructionRules(STRICT);

function body(subject: string): string {
  return [
    "## Working together",
    "",
    `Each ${subject} has members.`,
    "",
    "You can invite people and give them a role, and they see the same pages.",
    "",
    "A member can leave at any time, and an owner can remove a member from the settings page.",
    "",
    "Every change shows in the activity log, so the whole team can follow what happened and when it happened.",
  ].join("\n");
}

function page(text: string): string {
  return ["---", 'title: "Teams"', 'description: "How people work together in one shared place."', "---", "", text].join("\n");
}

const exhaustedLoop: AgentLoopReport = {
  termination: "agent_loop_exhausted",
  maxSteps: 12,
  steps: 12,
  finalizationTriggered: true,
  repeatedToolCallsBlocked: 0,
};

interface AttemptsInput {
  answers: readonly WriterRunResult[];
  mdxCompile?: boolean;
  minBodyLength?: number;
  repaired?: string | null;
}

function runAttempts(input: AttemptsInput) {
  const warnings: string[] = [];
  const diagnostics: WriterDiagnosticEvent[] = [];
  const hints: (string | undefined)[] = [];
  const run = runWriterAttempts({
    title: "Teams",
    description: "How people work together in one place, and what each role can do.",
    maxAttempts: 3,
    baseTokens: 1_000,
    expandedTokens: 2_000,
    ...(input.minBodyLength ? { minBodyLength: input.minBodyLength } : {}),
    targetedRepairClasses: ["mdx", "length"],
    validation: { mdxCompile: input.mdxCompile ?? false, instructionRules: rules },
    runOnce: async ({ attempt, retryHint }) => {
      hints.push(retryHint);
      return input.answers[attempt - 1] ?? input.answers.at(-1) ?? { text: "" };
    },
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
  return { run, warnings, diagnostics, hints };
}

describe("a page that only breaks the instructions is never dropped (H3)", () => {
  test("the last attempt stops at the token limit: the earlier soft-only draft stays", async () => {
    const { run } = runAttempts({
      answers: [
        { text: body("org"), finishReason: "stop" },
        { text: body("org"), finishReason: "length" },
        { text: body("org"), finishReason: "length" },
      ],
    });

    const result = await run;
    expect(result.content).toContain("Each org has members.");
    expect(result.remainingIssues.map((issue) => issue.check)).toEqual(["instructionTerminology"]);
  });

  test("the last attempt exhausts its agent loop: the earlier soft-only draft stays", async () => {
    const { run } = runAttempts({
      answers: [
        { text: body("org"), finishReason: "stop" },
        { text: body("org"), finishReason: "stop", loop: exhaustedLoop },
      ],
    });

    await expect(run).resolves.toMatchObject({ attempts: 3 });
  });

  test("a failed MDX repair keeps an earlier soft-only draft", async () => {
    const brokenMdx = [body("workspace"), "", "<Callout invalid=>", "Text.", "</Callout>"].join("\n");
    const { run } = runAttempts({
      mdxCompile: true,
      answers: [{ text: body("org"), finishReason: "stop" }, { text: brokenMdx, finishReason: "stop" }],
      repaired: null,
    });

    const result = await run;
    expect(result.content).toContain("Each org has members.");
  });

  test("without a soft-only draft the run still fails", async () => {
    const { run } = runAttempts({ answers: [{ text: body("org"), finishReason: "length" }] });

    await expect(run).rejects.toBeInstanceOf(PageValidationExhaustedError);
  });
});

describe("a successful repair still meets the instructions (H4)", () => {
  const short = "## Working together\n\nEach workspace has members.\n\nYou can invite people to it.\n\nA member can leave at any time.";

  test("a repaired page that breaks the instructions goes back to the writer", async () => {
    const { run, hints } = runAttempts({
      minBodyLength: 300,
      answers: [{ text: short, finishReason: "stop" }, { text: body("workspace"), finishReason: "stop" }],
      repaired: page(body("org")),
    });

    const result = await run;
    expect(result.attempts).toBe(2);
    expect(result.content).toContain("Each workspace has members.");
    expect(hints[1]).toContain("\"org\" (say \"workspace\")");
  });

  test("a repaired page that meets the instructions is returned as repaired", async () => {
    const repaired = page(body("workspace"));
    const { run } = runAttempts({ minBodyLength: 300, answers: [{ text: short, finishReason: "stop" }], repaired });

    await expect(run).resolves.toMatchObject({ attempts: 1, content: repaired, remainingIssues: [] });
  });

  test("on the last attempt a repaired page with a break is kept, with a trace", async () => {
    const { run, diagnostics } = runAttempts({
      minBodyLength: 300,
      answers: [{ text: short, finishReason: "stop" }],
      repaired: page(body("org")),
    });

    const result = await run;
    expect(result.content).toContain("Each org has members.");
    expect(diagnostics.some((event) => event.eventType === "writer_accepted_with_issues")).toBe(true);
  });
});

describe("a section repair may not add a break (H4)", () => {
  const brief = resolveDocumentationBrief({
    target: { kind: "public" },
    projectInstructions: {
      version: 1,
      instructions: STRICT,
      screening: { method: "heuristic", flags: [] },
      repositoryFile: { status: "disabled" },
    } satisfies GenerationInstructions,
  });
  const context: WriterContext = { analysis: analysisFixture, structure: { sections: [] }, answers: {}, documentationBrief: brief };
  const validation = { ...DEFAULT_WRITER_VALIDATION, mdxCompile: false };

  test("a splice that adds an avoided term is rejected", async () => {
    const gate = splicedPageInstructions(context, page(body("workspace")));

    await expect(validateSplicedPage(page(body("org")), validation, undefined, gate)).resolves.toMatchObject({ ok: false });
  });

  test("a splice that keeps a break the page already had is accepted", async () => {
    const gate = splicedPageInstructions(context, page(body("org")));

    await expect(validateSplicedPage(page(body("org")), validation, undefined, gate)).resolves.toMatchObject({ ok: true });
  });

  test("a splice that adds a section of a page type that is off is rejected", async () => {
    const gate = splicedPageInstructions(context, page(body("workspace")));
    const spliced = page(`${body("workspace")}\n\n## Troubleshooting\n\nRestart the service when it stops.`);

    await expect(validateSplicedPage(spliced, validation, undefined, gate)).resolves.toMatchObject({ ok: false });
  });

  test("without instructions there is no instruction gate", () => {
    expect(splicedPageInstructions({ ...context, documentationBrief: undefined }, page(body("org")))).toBeUndefined();
  });
});

describe("a kept page leaves a trace (M7)", () => {
  test("the last attempt reports the open instruction issues", async () => {
    const { run, warnings, diagnostics } = runAttempts({ answers: [{ text: body("org"), finishReason: "stop" }] });

    const result = await run;
    expect(result.remainingIssues.map((issue) => issue.check)).toEqual(["instructionTerminology"]);
    expect(warnings.some((warning) => warning.includes("open issues: instructionTerminology"))).toBe(true);
    expect(diagnostics.find((event) => event.eventType === "writer_accepted_with_issues")).toMatchObject({
      issueCodes: ["instructionTerminology"],
      instructionIssueCodes: ["instructionTerminology"],
    });
  });

  test("a clean page reports nothing", async () => {
    const { run, diagnostics } = runAttempts({ answers: [{ text: body("workspace"), finishReason: "stop" }] });

    await expect(run).resolves.toMatchObject({ remainingIssues: [] });
    expect(diagnostics.some((event) => event.eventType === "writer_accepted_with_issues")).toBe(false);
  });
});

describe("REST request samples follow the owner's languages (L12)", () => {
  const clients = ["curl", "node-fetch", "node-xhr", "python-requests", "python-httpx", "go"] as const;

  test("orders by the owner's languages and keeps the rest in their order", () => {
    expect(orderRequestClientsByLanguage(clients, ["python", "typescript"])).toEqual([
      "python-requests",
      "python-httpx",
      "node-fetch",
      "node-xhr",
      "curl",
      "go",
    ]);
  });

  test("keeps the project's order without owner languages, and never adds a client", () => {
    expect(orderRequestClientsByLanguage(clients, [])).toEqual(clients);
    expect(orderRequestClientsByLanguage(["go", "curl"], ["python", "curl"])).toEqual(["curl", "go"]);
  });

  test("the reference options of a run use the owner's order", () => {
    const brief = resolveDocumentationBrief({
      target: { kind: "public" },
      projectInstructions: {
        version: 1,
        instructions: { ...DEFAULT_DOXABOT_INSTRUCTIONS, codeLanguages: ["go"] },
        screening: { method: "heuristic", flags: [] },
        repositoryFile: { status: "disabled" },
      },
    });
    const options = restEndpointReferenceOptions({ analysis: analysisFixture, structure: { sections: [] }, answers: {}, documentationBrief: brief });

    expect(options.policy?.requestClients[0]).toBe("go");
  });
});
