import { describe, expect, test } from "vitest";
import {
  PageValidationExhaustedError,
  runWriterAttempts,
} from "../src/doxa-agent/writer-pipeline";
import {
  detectRestEndpointDuplicateSection,
  runPageValidation,
} from "../src/utils/page-validator";
import { buildFailedOutputExcerpt, buildRetryHint } from "../src/utils/retry-hint";
import {
  DEFAULT_WRITER_VALIDATION,
  type AgentLoopReport,
} from "../src";

const validBody = [
  "## Overview",
  "",
  "This page explains the runtime behavior with enough concrete detail to guide a maintainer.",
  "",
  "The second paragraph describes how callers use the API and what result they should expect.",
].join("\n");

const exhaustedAgentLoopReport: AgentLoopReport = {
  termination: "agent_loop_exhausted",
  maxSteps: 12,
  steps: 12,
  finalizationTriggered: true,
  repeatedToolCallsBlocked: 0,
};

describe("writer repair feedback", () => {
  test("keeps targeted repair MDX-only by default", async () => {
    expect(DEFAULT_WRITER_VALIDATION.targetedRepairClasses).toEqual(["mdx"]);
    let repairCalls = 0;
    const outputs = [
      validBody,
      `${validBody}\n\n${"Additional verified detail. ".repeat(20)}`,
    ];

    const result = await runWriterAttempts({
      title: "Runtime",
      description: "Runtime behavior",
      maxAttempts: 2,
      minBodyLength: 300,
      baseTokens: 100,
      expandedTokens: 200,
      validation: { mdxCompile: false },
      runOnce: async () => ({ text: outputs.shift() ?? validBody }),
      repairMdx: async () => {
        repairCalls++;
        throw new Error("Length repair must remain disabled by default.");
      },
      saveDebug: async () => "/tmp/default-targeted-repair.md",
    });

    expect(repairCalls).toBe(0);
    expect(result.attempts).toBe(2);
  });

  test("uses the page description when a valid body omits frontmatter", async () => {
    let writerCalls = 0;
    let repairCalls = 0;

    const result = await runWriterAttempts({
      title: "Runtime",
      description: "Explain verified runtime behavior for application maintainers.",
      maxAttempts: 3,
      minBodyLength: 20,
      targetedRepairClasses: ["mdx", "frontmatter", "length"],
      baseTokens: 100,
      expandedTokens: 200,
      validation: { mdxCompile: false },
      runOnce: async () => {
        writerCalls++;
        return { text: validBody };
      },
      repairMdx: async () => {
        repairCalls++;
        throw new Error("A valid composed description must not trigger repair.");
      },
      saveDebug: async () => "/tmp/description-fallback.md",
    });

    expect(writerCalls).toBe(1);
    expect(repairCalls).toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.content).toContain(
      'description: "Explain verified runtime behavior for application maintainers"',
    );
  });

  test.each([
    {
      repairClass: "frontmatter" as const,
      issueRule: "body-frontmatter-artifact",
      minBodyLength: 20,
      description: "Runtime behavior",
      initial: pageWithFrontmatterArtifact(),
      repaired: canonicalPage(validBody),
    },
    {
      repairClass: "length" as const,
      issueRule: "tooShort",
      minBodyLength: 300,
      description: "Runtime behavior",
      initial: validBody,
      repaired: canonicalPage(
        `${validBody}\n\n${"Additional verified detail. ".repeat(20)}`,
      ),
    },
  ])(
    "repairs a $repairClass issue before regenerating the full page",
    async ({ repairClass, issueRule, minBodyLength, description, initial, repaired }) => {
      let writerCalls = 0;
      let repairCalls = 0;
      const diagnostics: unknown[] = [];

      const result = await runWriterAttempts({
        pageId: "runtime",
        title: "Runtime",
        description,
        maxAttempts: 3,
        minBodyLength,
        targetedRepairClasses: [repairClass],
        baseTokens: 100,
        expandedTokens: 200,
        validation: { mdxCompile: false },
        runOnce: async () => {
          writerCalls++;
          return { text: initial };
        },
        repairMdx: async ({ issue, repairClass: observedClass }) => {
          repairCalls++;
          expect(observedClass).toBe(repairClass);
          expect(issue.rule).toBe(issueRule);
          expect(issue.line).toBeGreaterThan(0);
          expect(issue.col).toBeGreaterThan(0);
          return {
            ok: true,
            content: repaired,
            maxAttempts: 1,
            attempts: [{
              attempt: 1,
              accepted: true,
              rejectionReason: null,
              validationIssueCodes: [],
            }],
          };
        },
        saveDebug: async () => "/tmp/targeted-repair.md",
        onRepairDiagnostic: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      });

      expect(writerCalls).toBe(1);
      expect(repairCalls).toBe(1);
      expect(result.attempts).toBe(1);
      expect(result.content).toBe(repaired);
      expect(diagnostics).toMatchObject([{
        repairClass,
        rule: issueRule,
        repairKind: "model_patch",
        repairSucceeded: true,
      }]);
    },
  );

  test.each([
    {
      repairClass: "frontmatter" as const,
      issueRule: "body-frontmatter-artifact",
      minBodyLength: 20,
      description: "Runtime behavior",
      initial: pageWithFrontmatterArtifact(),
    },
    {
      repairClass: "length" as const,
      issueRule: "tooShort",
      minBodyLength: 300,
      description: "Runtime behavior",
      initial: validBody,
    },
  ])(
    "falls back from an unsuccessful $repairClass repair without changing retry feedback",
    async ({ repairClass, issueRule, minBodyLength, description, initial }) => {
      const receivedHints: Array<string | undefined> = [];
      const diagnostics: unknown[] = [];
      let repairCalls = 0;
      const regenerated = canonicalPage(
        `${validBody}\n\n${"Additional verified detail. ".repeat(20)}`,
        "Explain verified runtime behavior.",
      );

      const result = await runWriterAttempts({
        pageId: "runtime",
        title: "Runtime",
        description,
        maxAttempts: 2,
        minBodyLength,
        targetedRepairClasses: [repairClass],
        baseTokens: 100,
        expandedTokens: 200,
        validation: { mdxCompile: false },
        runOnce: async ({ retryHint }) => {
          receivedHints.push(retryHint);
          return {
            text: receivedHints.length === 1 ? initial : regenerated,
          };
        },
        repairMdx: async () => {
          repairCalls++;
          return {
            ok: false,
            content: null,
            maxAttempts: 1,
            attempts: [{
              attempt: 1,
              accepted: false,
              rejectionReason: "targeted patch did not pass validation",
              validationIssueCodes: [issueRule],
            }],
          };
        },
        saveDebug: async () => "/tmp/targeted-repair-fallback.md",
        onRepairDiagnostic: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      });

      expect(repairCalls).toBe(1);
      expect(result.attempts).toBe(2);
      expect(receivedHints).toHaveLength(2);
      expect(receivedHints[1]).toContain("FIX NOW r0.a1");
      expect(receivedHints[1]).toContain(issueRule);
      const baselineHints: Array<string | undefined> = [];
      await runWriterAttempts({
        pageId: "runtime",
        title: "Runtime",
        description,
        maxAttempts: 2,
        minBodyLength,
        targetedRepairClasses: [],
        baseTokens: 100,
        expandedTokens: 200,
        validation: { mdxCompile: false },
        runOnce: async ({ retryHint }) => {
          baselineHints.push(retryHint);
          return {
            text: baselineHints.length === 1 ? initial : regenerated,
          };
        },
        saveDebug: async () => "/tmp/targeted-repair-fallback.md",
      });
      expect(receivedHints[1]).toBe(baselineHints[1]);
      expect(diagnostics).toMatchObject([{
        repairClass,
        rule: issueRule,
        repairSucceeded: false,
        validationIssueCodes: [issueRule],
      }]);
    },
  );

  test("renders the latest issues as outstanding and older attempts as compact history", () => {
    const issue = (check: string, line: number, message: string) => ({
      check,
      severity: "hard" as const,
      message,
      fixInstruction: `Fix ${check} without repeating it.`,
      location: { line, snippet: `${check} offending source` },
    });
    const history = [
      {
        pageRetry: 0,
        attempt: 1,
        maxAttempts: 5,
        issues: [issue("residualFrontmatter", 0, "Remove duplicated frontmatter")],
        rawContent: "FIRST_FULL_FAILED_OUTPUT_SHOULD_NOT_BE_INCLUDED",
        debugPath: "/tmp/debug-attempt-1.md",
      },
      {
        pageRetry: 0,
        attempt: 2,
        maxAttempts: 5,
        issues: [issue("unexpected-character", 37, "Escape the raw less-than character")],
        rawContent: "SECOND_FULL_FAILED_OUTPUT_SHOULD_NOT_BE_INCLUDED",
        debugPath: "/tmp/debug-attempt-2.md",
      },
    ];

    const hint = buildRetryHint({
      pageRetry: 0,
      attempt: 3,
      maxAttempts: 5,
      issues: [issue("unexpected-character", 41, "Current parse failure")],
      rawContent: "CURRENT_FAILED_OUTPUT",
      debugPath: "/tmp/debug-attempt-3.md",
      previousAttempts: history,
    } as Parameters<typeof buildRetryHint>[0]);

    expect(hint).toContain("FIX NOW r0.a3");
    expect(hint).toContain("unexpected-character@42: Current parse failure");
    expect(hint).toContain("AVOID REGRESSIONS");
    expect(hint.indexOf("r0.a1 residualFrontmatter@1")).toBeLessThan(
      hint.indexOf("r0.a2 unexpected-character@38"),
    );
    expect(hint).not.toContain("FIRST_FULL_FAILED_OUTPUT_SHOULD_NOT_BE_INCLUDED");
    expect(hint).not.toContain("debug-attempt-1.md");
    expect(hint.length).toBeLessThanOrEqual(6_000);
  });

  test("keeps cumulative retry prompts within the fixed character budget", () => {
    const issue = (check: string, line: number) => ({
      check,
      severity: "hard" as const,
      message: `Failure ${"detail ".repeat(200)}`,
      fixInstruction: `Repair ${"instruction ".repeat(200)}`,
      location: { line, snippet: `Snippet ${"source ".repeat(200)}` },
    });
    const previousAttempts = Array.from({ length: 10 }, (_, index) => ({
      pageRetry: index < 5 ? 0 : 1,
      attempt: (index % 5) + 1,
      maxAttempts: 5,
      issues: [issue(`prior-rule-${index}`, index)],
      rawContent: `HISTORICAL_RAW_${index}_${"x".repeat(10_000)}`,
      debugPath: `/tmp/history-${index}.md`,
    }));

    const hint = buildRetryHint({
      pageRetry: 1,
      attempt: 5,
      maxAttempts: 5,
      issues: Array.from({ length: 8 }, (_, index) => issue(`current-rule-${index}`, index)),
      rawContent: "CURRENT_RAW",
      debugPath: "/tmp/current.md",
      previousAttempts,
    });

    expect(hint.length).toBeLessThanOrEqual(6_000);
    expect(hint).toContain("FIX NOW r1.a5");
    expect(hint).toContain("r0.a1 prior-rule-0@1");
    expect(hint).toContain("r1.a5 prior-rule-9@10");
    expect(hint).not.toContain("HISTORICAL_RAW_");
    expect(hint).not.toContain("/tmp/history-");
    expect(hint.endsWith("Return corrected MDX only.")).toBe(true);
  });

  test("treats duplicate body frontmatter as the same hard validation failure everywhere", async () => {
    const content = [
      "---",
      'title: "Runtime"',
      'description: "Runtime behavior"',
      "---",
      "",
      validBody,
      "",
      "---",
      'title: "Duplicate"',
      'description: "Must not be here"',
      "---",
    ].join("\n");

    const report = await runPageValidation(content, { mdxCompile: false, minBodyLength: 20 });
    const duplicate = report.issues.find((issue) => issue.rule === "body");

    expect(report.ok).toBe(false);
    expect(duplicate).toMatchObject({ severity: "hard" });
    expect(duplicate?.line).toBeGreaterThan(1);
    expect(duplicate?.snippet).toContain("---");
  });

  test("rejects frontmatter-shaped body metadata with a longer opening delimiter", async () => {
    const content = [
      "---",
      'title: "Product Context"',
      'description: "Explain the product context"',
      "---",
      "",
      "## Product Context",
      "",
      "----",
      'title: "Product Context"',
      'description: "Duplicated metadata must not render as documentation"',
      'keywords: ["context", "product"]',
      'icon: "target"',
      "---",
      "",
      validBody,
    ].join("\n");

    const report = await runPageValidation(content, {
      mdxCompile: false,
      minBodyLength: 20,
    });
    const duplicate = report.issues.find((issue) => issue.rule === "body-frontmatter-artifact");

    expect(report.ok).toBe(false);
    expect(duplicate).toMatchObject({
      severity: "hard",
      line: 8,
    });
    expect(duplicate?.snippet).toContain('title: "Product Context"');
    expect(duplicate?.hint).toContain("Remove the duplicated metadata block");
  });

  test("rejects metadata collapsed onto a body line", async () => {
    const content = [
      "---",
      'title: "Product Context"',
      'description: "Explain the product context"',
      "---",
      "",
      "## Product Context",
      "",
      'title: "Product Context" description: "Define the product purpose" keywords: ["context"] icon: "target"',
      "",
      validBody,
    ].join("\n");

    const report = await runPageValidation(content, {
      mdxCompile: false,
      minBodyLength: 20,
    });

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        rule: "body-frontmatter-artifact",
        severity: "hard",
        line: 8,
      }),
    );
  });

  test("allows frontmatter examples inside fenced code blocks", async () => {
    const content = [
      "---",
      'title: "Authoring"',
      'description: "Show how to author documentation"',
      "---",
      "",
      validBody,
      "",
      "```md",
      "----",
      'title: "Example"',
      'description: "This is intentionally shown as source"',
      "---",
      "```",
    ].join("\n");

    const report = await runPageValidation(content, {
      mdxCompile: false,
      minBodyLength: 20,
    });

    expect(report.issues.some((issue) => issue.rule === "body-frontmatter-artifact")).toBe(false);
  });

  test("reports body issue locations as one-indexed source lines", async () => {
    const lines = [
      "---",
      'title: "Runtime"',
      'description: "Runtime behavior"',
      "---",
      "",
      "## Overview",
      "",
      "This paragraph provides enough grounded explanation for the validator to inspect.",
      "",
      "This final paragraph is deliberately cut off before it can finish",
    ];
    const report = await runPageValidation(lines.join("\n"), {
      mdxCompile: false,
      minBodyLength: 20,
    });

    expect(report.issues.find((issue) => issue.rule === "cutoffContent")?.line).toBe(10);
  });

  test.each([
    "Endpoint",
    "request",
    "Request Body",
    "RESPONSE",
    "Responses",
    "Authentication",
    "Authorization",
    "Parameters",
    "Path Parameters",
    "Query Parameters",
    "Body",
    "Errors",
    "Example",
    "Examples",
  ])("rejects the renderer-owned REST endpoint section %s", async (heading) => {
    const content = [
      "---",
      'title: "Create widget"',
      'description: "Create a widget through the public REST API."',
      "---",
      "",
      `### ${heading}`,
      "",
      "This duplicate section repeats content that the endpoint renderer already provides.",
      "",
      "A second paragraph keeps this fixture above the minimum body size.",
    ].join("\n");

    const report = await runPageValidation(content, {
      mdxCompile: false,
      minBodyLength: 20,
      restEndpointPage: true,
    });

    expect(report.issues).toContainEqual(expect.objectContaining({
      rule: "restEndpointDuplicateSection",
      severity: "hard",
      line: 6,
      hint: expect.stringContaining(`Remove the heading "${heading}"`),
    }));
  });

  test("does not apply the REST duplicate-section rule to other pages or code fences", async () => {
    const content = [
      "---",
      'title: "Request guide"',
      'description: "Explain how request processing works for application developers."',
      "---",
      "",
      "# Request",
      "",
      "#### Response",
      "",
      "```md",
      "## Authentication",
      "```",
      "",
      "This guide explains requests without duplicating a rendered REST endpoint section.",
      "",
      "The second paragraph provides enough complete content for validation.",
    ].join("\n");

    const endpointReport = await runPageValidation(content, {
      mdxCompile: false,
      minBodyLength: 20,
      restEndpointPage: true,
    });
    const regularReport = await runPageValidation(
      content.replace("#### Response", "## Response"),
      { mdxCompile: false, minBodyLength: 20 },
    );

    expect(endpointReport.issues.some(
      (issue) => issue.rule === "restEndpointDuplicateSection",
    )).toBe(false);
    expect(regularReport.issues.some(
      (issue) => issue.rule === "restEndpointDuplicateSection",
    )).toBe(false);
  });

  test("reports a duplicate REST endpoint section as a hard issue at its heading, with no fix by code", () => {
    const body = [
      "Introductory endpoint behavior.",
      "",
      "## Request",
      "",
      "Duplicate request content.",
      "",
      "### Nested details",
      "",
      "Nested duplicate content.",
      "",
      "## Behavior",
      "",
      "Source-grounded behavior remains.",
    ].join("\n");
    const issue = detectRestEndpointDuplicateSection(body);

    expect(issue).toMatchObject({
      check: "restEndpointDuplicateSection",
      severity: "hard",
      location: { line: 2, snippet: "## Request" },
    });
    expect(issue).not.toHaveProperty("autoFix");
  });

  test("retries a REST endpoint draft that duplicates a renderer-owned section", async () => {
    const hints: Array<string | undefined> = [];
    const duplicateBody = [
      "## Request",
      "",
      "This duplicate request section contains enough prose for validation.",
      "",
      "This second paragraph is also complete and source-grounded.",
    ].join("\n");

    const result = await runWriterAttempts({
      title: "Create widget",
      description: "Create a widget through the public REST API.",
      maxAttempts: 2,
      minBodyLength: 20,
      baseTokens: 100,
      expandedTokens: 200,
      validation: { mdxCompile: false, restEndpointPage: true },
      runOnce: async ({ retryHint, attempt }) => {
        hints.push(retryHint);
        return { text: attempt === 1 ? duplicateBody : validBody };
      },
      saveDebug: async () => "/tmp/rest-duplicate.md",
    });

    expect(result.attempts).toBe(2);
    expect(hints[1]).toContain("restEndpointDuplicateSection");
    expect(result.content).not.toContain("## Request");
  });

  test("uses outer-retry feedback on the first writer attempt", async () => {
    let receivedHint: string | undefined;

    const result = await runWriterAttempts({
      title: "Runtime",
      description: "Runtime behavior",
      initialRetryHint: "Repair the previous MDX parse failure at line 18.",
      maxAttempts: 1,
      minBodyLength: 20,
      baseTokens: 100,
      expandedTokens: 200,
      validation: { mdxCompile: false },
      runOnce: async ({ retryHint }) => {
        receivedHint = retryHint;
        return { text: validBody };
      },
      saveDebug: async () => "/tmp/debug.md",
    });

    expect(receivedHint).toContain("previous MDX parse failure");
    expect(result.content).toContain("This page explains the runtime behavior");
  });

  test("accepts a model-patched located MDX error without regenerating the page", async () => {
    let writerCalls = 0;
    let repairCycles = 0;
    const diagnostics: unknown[] = [];
    const result = await runWriterAttempts({
      pageId: "limits",
      title: "Limits",
      description: "Runtime limits",
      maxAttempts: 3,
      minBodyLength: 20,
      baseTokens: 100,
      expandedTokens: 200,
      validation: { mdxCompile: true },
      runOnce: async () => {
        writerCalls++;
        return {
          text: [
            "## Limits",
            "",
            "Requests normally complete in <25 ms under the documented load.",
            "",
            "Use this limit to configure a conservative client timeout.",
          ].join("\n"),
        };
      },
      repairMdx: async ({ draft }) => {
        repairCycles++;
        return {
          ok: true,
          content: draft.replace("<25 ms", "&lt;25 ms"),
          maxAttempts: 3,
          attempts: [{
            attempt: 1,
            accepted: true,
            rejectionReason: null,
            validationIssueCodes: [],
          }],
        };
      },
      saveDebug: async () => "/tmp/limits.md",
      onRepairDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    });

    expect(writerCalls).toBe(1);
    expect(repairCycles).toBe(1);
    expect(result.content).toContain("&lt;25 ms");
    expect(diagnostics).toMatchObject([{
      pageId: "limits",
      rule: "unexpected-character",
      repairKind: "model_patch",
      repairSucceeded: true,
      attempt: 1,
      maxAttempts: 3,
    }]);
  });

  test("reports three model repair attempts without regenerating the page", async () => {
    let writerCalls = 0;
    let repairCycles = 0;
    const diagnostics: unknown[] = [];
    let exhausted: PageValidationExhaustedError | undefined;

    try {
      await runWriterAttempts({
        pageId: "limits",
        title: "Limits",
        description: "Runtime limits",
        maxAttempts: 3,
        minBodyLength: 20,
        baseTokens: 100,
        expandedTokens: 200,
        validation: { mdxCompile: true },
        runOnce: async () => {
          writerCalls++;
          return {
            text: [
              "## Limits",
              "",
              "<Callout invalid=>",
              "This paragraph explains the runtime limits in enough detail.",
              "</Callout>",
              "",
              "Use these limits to configure a conservative client timeout.",
            ].join("\n"),
          };
        },
        repairMdx: async () => {
          repairCycles++;
          return {
            ok: false,
            content: null,
            maxAttempts: 3,
            attempts: [1, 2, 3].map((attempt) => ({
              attempt,
              accepted: false,
              rejectionReason: "patched-page-validation-failed:unexpected-character",
              validationIssueCodes: ["unexpected-character"],
            })),
          };
        },
        saveDebug: async () => "/tmp/limits.md",
        onRepairDiagnostic: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      });
    } catch (error) {
      exhausted = error as PageValidationExhaustedError;
    }

    expect(exhausted).toBeInstanceOf(PageValidationExhaustedError);
    expect(exhausted?.attempts).toBe(3);
    expect(writerCalls).toBe(1);
    expect(repairCycles).toBe(1);
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.map((entry: any) => entry.attempt)).toEqual([1, 2, 3]);
    expect(diagnostics.every((entry: any) => entry.repairSucceeded === false))
      .toBe(true);
  });

  test("keeps three-patch repair budgets isolated across an outer page retry", async () => {
    const brokenBody = [
      "## Limits",
      "",
      "<Callout invalid=>",
      "This paragraph explains the runtime limits in enough detail.",
      "</Callout>",
      "",
      "Use these limits to configure a conservative client timeout.",
    ].join("\n");
    const pageRetries: number[] = [];
    let writerCalls = 0;
    const repairResult = {
      ok: false as const,
      content: null,
      maxAttempts: 3,
      attempts: [1, 2, 3].map((attempt) => ({
        attempt,
        accepted: false,
        rejectionReason: "patched-page-validation-failed:unexpected-character",
        validationIssueCodes: ["unexpected-character"],
      })),
    };
    const baseOptions = {
      pageId: "limits",
      title: "Limits",
      description: "Runtime limits",
      maxAttempts: 3,
      minBodyLength: 20,
      baseTokens: 100,
      expandedTokens: 200,
      validation: { mdxCompile: true },
      runOnce: async () => {
        writerCalls++;
        return { text: brokenBody };
      },
      repairMdx: async ({ pageRetry }: { pageRetry: number }) => {
        pageRetries.push(pageRetry);
        return repairResult;
      },
      saveDebug: async () => "/tmp/limits.md",
    };

    let firstError: PageValidationExhaustedError | undefined;
    try {
      await runWriterAttempts(baseOptions);
    } catch (error) {
      firstError = error as PageValidationExhaustedError;
    }
    expect(firstError).toBeInstanceOf(PageValidationExhaustedError);

    let secondError: PageValidationExhaustedError | undefined;
    try {
      await runWriterAttempts({
        ...baseOptions,
        pageRetry: 1,
        initialValidationHistory: firstError?.validationHistory,
      });
    } catch (error) {
      secondError = error as PageValidationExhaustedError;
    }

    expect(secondError).toBeInstanceOf(PageValidationExhaustedError);
    expect(secondError?.attempts).toBe(3);
    expect(writerCalls).toBe(2);
    expect(pageRetries).toEqual([0, 1]);
    expect(secondError?.validationHistory.map((entry) => entry.pageRetry))
      .toEqual([0, 1]);
  });

  test("accumulates validation history across writer attempts", async () => {
    const cutoffBody = [
      "## Overview",
      "",
      "This paragraph provides enough grounded explanation for the validator to inspect.",
      "",
      "This final paragraph is deliberately cut off before it can finish",
    ].join("\n");
    const receivedHints: Array<string | undefined> = [];
    const outputs = ["## Overview\n\n- TODO", cutoffBody, validBody];

    const result = await runWriterAttempts({
      title: "Runtime",
      description: "Runtime behavior",
      maxAttempts: 3,
      minBodyLength: 0,
      baseTokens: 100,
      expandedTokens: 200,
      validation: { mdxCompile: false },
      runOnce: async ({ retryHint }) => {
        receivedHints.push(retryHint);
        return { text: outputs[receivedHints.length - 1] };
      },
      saveDebug: async (attempt) => `/tmp/debug-${attempt}.md`,
    });

    expect(receivedHints[0]).toBeUndefined();
    expect(receivedHints[1]).toContain("FIX NOW r0.a1");
    expect(receivedHints[1]).toContain("skeletonPage");
    expect(receivedHints[2]).toContain("FIX NOW r0.a2");
    expect(receivedHints[2]).toContain("cutoffContent");
    expect(receivedHints[2]).toContain("AVOID REGRESSIONS");
    expect(receivedHints[2]).toContain("r0.a1 skeletonPage");
    expect(result.attempts).toBe(3);
  });

  test("reports attempt timing and validation outcomes without exposing page content", async () => {
    const diagnostics: unknown[] = [];
    const outputs = ["## Overview\n\n- TODO", validBody];

    await runWriterAttempts({
      title: "Runtime",
      description: "Runtime behavior",
      pageRetry: 1,
      maxAttempts: 2,
      minBodyLength: 0,
      baseTokens: 100,
      expandedTokens: 200,
      validation: { mdxCompile: false },
      runOnce: async () => ({ text: outputs.shift() ?? validBody, finishReason: "stop" }),
      saveDebug: async (attempt) => `/tmp/diagnostic-${attempt}.md`,
      onDiagnostic: (event: unknown) => diagnostics.push(event),
    });

    expect(diagnostics).toMatchObject([
      {
        eventType: "writer_attempt_started",
        pageTitle: "Runtime",
        pageRetry: 1,
        attempt: 1,
        maxAttempts: 2,
        maxTokens: 100,
      },
      {
        eventType: "writer_model_completed",
        pageTitle: "Runtime",
        pageRetry: 1,
        attempt: 1,
        rawChars: 19,
        finishReason: "stop",
      },
      {
        eventType: "writer_validation_completed",
        pageTitle: "Runtime",
        pageRetry: 1,
        attempt: 1,
        issueCodes: ["skeletonPage", "cutoffContent"],
        hardIssueCount: 1,
        willRetry: true,
      },
      {
        eventType: "writer_attempt_started",
        pageTitle: "Runtime",
        pageRetry: 1,
        attempt: 2,
      },
      {
        eventType: "writer_model_completed",
        pageTitle: "Runtime",
        pageRetry: 1,
        attempt: 2,
        finishReason: "stop",
      },
      {
        eventType: "writer_validation_completed",
        pageTitle: "Runtime",
        pageRetry: 1,
        attempt: 2,
        issueCodes: [],
        hardIssueCount: 0,
        willRetry: false,
      },
    ]);
    const completedDiagnostics = diagnostics.filter((event) =>
      typeof event === "object" &&
      event !== null &&
      (event as { eventType?: unknown }).eventType !== "writer_attempt_started"
    );
    expect(completedDiagnostics.every((event) =>
      typeof (event as { durationMs?: unknown }).durationMs === "number"
    )).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain("This page explains");
    expect(JSON.stringify(diagnostics)).not.toContain("rawContent");
  });

  test("carries structured history into an outer retry", async () => {
    let firstError: PageValidationExhaustedError | undefined;
    try {
      await runWriterAttempts({
        title: "Runtime",
        description: "Runtime behavior",
        pageRetry: 0,
        maxAttempts: 1,
        minBodyLength: 0,
        baseTokens: 100,
        expandedTokens: 200,
        validation: { mdxCompile: false },
        runOnce: async () => ({ text: "## Overview\n\n- TODO" }),
        saveDebug: async () => "/tmp/first-run.md",
      });
    } catch (error) {
      firstError = error as PageValidationExhaustedError;
    }

    expect(firstError).toBeInstanceOf(PageValidationExhaustedError);
    const receivedHints: Array<string | undefined> = [];
    const result = await runWriterAttempts({
      title: "Runtime",
      description: "Runtime behavior",
      pageRetry: 1,
      initialValidationHistory: firstError!.validationHistory,
      maxAttempts: 2,
      minBodyLength: 0,
      baseTokens: 100,
      expandedTokens: 200,
      validation: { mdxCompile: false },
      runOnce: async ({ retryHint }) => {
        receivedHints.push(retryHint);
        return { text: receivedHints.length === 1 ? "## Overview\n\n- TODO" : validBody };
      },
      saveDebug: async () => "/tmp/outer-retry.md",
    });

    expect(receivedHints[0]).toContain("FIX NOW r0.a1");
    expect(receivedHints[1]).toContain("FIX NOW r1.a1");
    expect(receivedHints[1]).toContain("AVOID REGRESSIONS");
    expect(receivedHints[1]).toContain("r0.a1 skeletonPage");
    expect(result.attempts).toBe(2);
  });

  test("keeps validation history isolated between pages", async () => {
    const historyFor = (check: string) => [{
      pageRetry: 0,
      attempt: 1,
      maxAttempts: 5,
      issues: [{
        check,
        severity: "hard" as const,
        message: `${check} failed`,
        fixInstruction: `Fix ${check}`,
      }],
      rawContent: `${check} raw output`,
      debugPath: `/tmp/${check}.md`,
    }];
    const firstHints: Array<string | undefined> = [];
    const secondHints: Array<string | undefined> = [];

    await Promise.all([
      runWriterAttempts({
        title: "Page A",
        description: "First page",
        pageRetry: 1,
        initialValidationHistory: historyFor("page-a-rule"),
        maxAttempts: 1,
        minBodyLength: 0,
        baseTokens: 100,
        expandedTokens: 200,
        validation: { mdxCompile: false },
        runOnce: async ({ retryHint }) => {
          firstHints.push(retryHint);
          return { text: validBody };
        },
        saveDebug: async () => "/tmp/page-a.md",
      }),
      runWriterAttempts({
        title: "Page B",
        description: "Second page",
        pageRetry: 1,
        initialValidationHistory: historyFor("page-b-rule"),
        maxAttempts: 1,
        minBodyLength: 0,
        baseTokens: 100,
        expandedTokens: 200,
        validation: { mdxCompile: false },
        runOnce: async ({ retryHint }) => {
          secondHints.push(retryHint);
          return { text: validBody };
        },
        saveDebug: async () => "/tmp/page-b.md",
      }),
    ]);

    expect(firstHints[0]).toContain("page-a-rule");
    expect(firstHints[0]).not.toContain("page-b-rule");
    expect(secondHints[0]).toContain("page-b-rule");
    expect(secondHints[0]).not.toContain("page-a-rule");
  });

  test("preserves structured issues and failed content after attempts are exhausted", async () => {
    const failedContent = "## Overview\n\n- TODO";

    await expect(runWriterAttempts({
      title: "Runtime",
      description: "Runtime behavior",
      maxAttempts: 1,
      minBodyLength: 0,
      baseTokens: 100,
      expandedTokens: 200,
      validation: { mdxCompile: false },
      runOnce: async () => ({ text: failedContent }),
      saveDebug: async () => "/tmp/debug.md",
    })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(PageValidationExhaustedError);
      const exhausted = error as PageValidationExhaustedError;
      expect(exhausted.issues.some((issue) => issue.check === "skeletonPage")).toBe(true);
      expect(exhausted.failedContent).toContain("TODO");
      expect(exhausted.retryHint).toContain("skeletonPage");
      expect(exhausted.validationHistory).toHaveLength(1);
      expect(exhausted.validationHistory[0].rawContent).toBe(failedContent);
      return true;
    });
  });

  test("preserves a token-limited draft for the bounded outer retry", async () => {
    const failedContent = `${validBody}\n\n${"detail ".repeat(100)}`;

    await expect(runWriterAttempts({
      title: "Runtime",
      description: "Runtime behavior",
      maxAttempts: 1,
      baseTokens: 100,
      expandedTokens: 200,
      validation: { mdxCompile: false },
      runOnce: async () => ({
        text: failedContent,
        finishReason: "length",
        loop: exhaustedAgentLoopReport,
      }),
      saveDebug: async () => "/tmp/debug.md",
    })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(PageValidationExhaustedError);
      const exhausted = error as PageValidationExhaustedError;
      expect(exhausted.issues).toMatchObject([{ check: "tokenLimit", severity: "hard" }]);
      expect(exhausted.failedContent).toContain("runtime behavior");
      expect(exhausted.retryHint).toContain("Be more concise");
      expect(exhausted.retryHint).toContain("This page explains the runtime behavior");
      expect(exhausted.retryHint).not.toContain("/tmp/debug.md");
      return true;
    });
  });

  test("retries typed agent-loop exhaustion inside the page writer", async () => {
    const diagnostics: unknown[] = [];
    const receivedHints: Array<string | undefined> = [];
    const exhaustedLoop: AgentLoopReport = {
      ...exhaustedAgentLoopReport,
      repeatedToolCallsBlocked: 2,
    };

    const result = await runWriterAttempts({
      title: "Runtime",
      description: "Runtime behavior",
      maxAttempts: 2,
      minBodyLength: 20,
      baseTokens: 100,
      expandedTokens: 200,
      validation: { mdxCompile: false },
      runOnce: async ({ retryHint }) => {
        receivedHints.push(retryHint);
        return receivedHints.length === 1
          ? {
              text: "",
              finishReason: "tool_calls",
              loop: exhaustedLoop,
            }
          : {
              text: validBody,
              finishReason: "stop",
            };
      },
      saveDebug: async (attempt) => `/tmp/loop-exhausted-${attempt}.md`,
      onDiagnostic: (event) => diagnostics.push(event),
    });

    expect(receivedHints).toHaveLength(2);
    expect(receivedHints[1]).toContain("agent loop exhausted");
    expect(result.content).toContain("## Overview");
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        eventType: "writer_model_completed",
        steps: 12,
        loopTermination: "agent_loop_exhausted",
        finalizationTriggered: true,
        repeatedToolCallsBlocked: 2,
      }),
    );
  });

  test("reports agent-loop exhaustion after all writer attempts", async () => {
    try {
      await runWriterAttempts({
        title: "Runtime",
        description: "Runtime behavior",
        maxAttempts: 2,
        minBodyLength: 20,
        baseTokens: 100,
        expandedTokens: 200,
        validation: { mdxCompile: false },
        runOnce: async () => ({
          text: "",
          finishReason: "tool_calls",
          loop: exhaustedAgentLoopReport,
        }),
        saveDebug: async (attempt) => `/tmp/loop-exhausted-${attempt}.md`,
      });
      throw new Error("Expected writer attempts to exhaust");
    } catch (error) {
      expect(error).toBeInstanceOf(PageValidationExhaustedError);
      if (!(error instanceof PageValidationExhaustedError)) {
        throw error;
      }
      expect(error.issues).toContainEqual(
        expect.objectContaining({
          check: "agentLoopExhausted",
          severity: "hard",
        }),
      );
    }
  });

  test("keeps a normal failed page intact in retry context", () => {
    const content = `${"a".repeat(1_500)}\nMIDDLE_FAILURE\n${"b".repeat(1_500)}`;
    expect(buildFailedOutputExcerpt(content)).toBe(content);
  });
});

function canonicalPage(
  body: string,
  description = "Explain the runtime behavior.",
): string {
  return [
    "---",
    'title: "Runtime"',
    `description: "${description}"`,
    "---",
    "",
    body,
  ].join("\n");
}

function pageWithFrontmatterArtifact(): string {
  return canonicalPage([
    validBody,
    "",
    'title: "Runtime" description: "Duplicate metadata" keywords: ["runtime"] icon: "box"',
  ].join("\n"));
}
