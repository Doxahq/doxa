import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseRuntimeMdx,
  type RuntimeMdxElementNode,
  type RuntimeMdxNode,
} from "@doxahq/mdx-runtime";
import { describe, expect, test } from "vitest";

import { cleanWriterBody } from "../src/doxa-agent/writer-pipeline";
import { parseFrontmatter } from "../src/utils/frontmatter";
import {
  checkContentQuality,
  runPageValidation,
} from "../src/utils/page-validator";
import { findStepProblems, normalizeStepBlocks } from "../src/utils/step-blocks";

const fixtureDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "step-structure",
);

/** A generated page (flagforge PR 14) that wrote one `<Step title>` per step. */
async function titledStepsPage(): Promise<string> {
  return readFile(join(fixtureDirectory, "titled-steps.mdx"), "utf8");
}

function elements(nodes: readonly RuntimeMdxNode[], name: string): RuntimeMdxElementNode[] {
  return nodes.flatMap((node) => {
    if (node.type !== "element") return [];
    const own = node.name === name ? [node] : [];
    return [...own, ...elements(node.children ?? [], name)];
  });
}

/** The steps the renderer draws: each element child of each `<Step>`. */
function renderedSteps(source: string) {
  const document = parseRuntimeMdx(source);
  return elements(document.nodes, "Step").map((step) =>
    (step.children ?? [])
      .filter((child): child is RuntimeMdxElementNode => child.type === "element")
      .map((child) => ({ name: child.name, title: child.props?.title })),
  );
}

describe("normalizeStepBlocks", () => {
  test("turns a run of <Step title> blocks into one Step with titled StepItems", async () => {
    const { body } = parseFrontmatter(await titledStepsPage());
    expect(renderedSteps(body)[0]?.[0]).toEqual({ name: "p", title: undefined });

    const fixed = normalizeStepBlocks(body);

    expect(renderedSteps(fixed)).toEqual([
      [
        { name: "StepItem", title: "Add a key to every variation" },
        { name: "StepItem", title: "Replace numeric references with keys" },
        { name: "StepItem", title: "Update the flag config and targeting calls" },
        { name: "StepItem", title: "Update clients that read evaluation results" },
      ],
    ]);
    expect(findStepProblems(fixed)).toEqual([]);
  });

  test("keeps every line of the step bodies, code fences included", async () => {
    const { body } = parseFrontmatter(await titledStepsPage());
    const fixed = normalizeStepBlocks(body);
    const withoutStepTags = (text: string) =>
      text
        .split("\n")
        .filter((line) => !/^\s*<\/?Step(Item)?\b/.test(line) && line.trim() !== "");

    expect(withoutStepTags(fixed)).toEqual(withoutStepTags(body));
  });

  test("rewrites one-line and quoted-title forms", () => {
    const fixed = normalizeStepBlocks(
      [
        `<Step title='Install'>Run the installer.</Step>`,
        "",
        `<Step title={"Greet"}>`,
        "Greet the user.",
        "</Step>",
      ].join("\n"),
    );

    expect(fixed).toContain('<StepItem title="Install">\nRun the installer.\n</StepItem>');
    expect(renderedSteps(fixed)).toHaveLength(1);
  });

  test("starts a new Step when prose separates two runs", () => {
    const fixed = normalizeStepBlocks(
      [
        '<Step title="One">',
        "First.",
        "</Step>",
        "",
        "Some prose between the procedures.",
        "",
        '<Step title="Two">',
        "Second.",
        "</Step>",
      ].join("\n"),
    );

    expect(renderedSteps(fixed)).toEqual([
      [{ name: "StepItem", title: "One" }],
      [{ name: "StepItem", title: "Two" }],
    ]);
  });

  test("leaves code fences and valid steps unchanged", () => {
    const source = [
      "````jsx",
      '<Step title="Shown as an example">',
      "</Step>",
      "````",
      "",
      "<Step>",
      '  <StepItem title="Install">```bash pnpm install ```</StepItem>',
      "</Step>",
    ].join("\n");

    expect(normalizeStepBlocks(source)).toBe(source);
  });

  test("leaves a titled Step that already holds StepItems for the model to fix", () => {
    const source = [
      '<Step title="Setup">',
      '<StepItem title="Install">Run it.</StepItem>',
      "</Step>",
    ].join("\n");

    expect(normalizeStepBlocks(source)).toBe(source);
  });
});

describe("findStepProblems", () => {
  test("accepts the documented Step shapes", () => {
    const source = [
      "<Step>",
      '  <StepItem title="Create the environment">',
      "    Send a POST request.",
      "",
      "    ```bash",
      "    curl -X POST https://api.example.com/environments",
      "    ```",
      "  </StepItem>",
      '  <StepItem title="Install">```bash pnpm install ```</StepItem>',
      "</Step>",
    ].join("\n");

    expect(findStepProblems(source)).toEqual([]);
  });

  test("ignores Step tags quoted in inline code", () => {
    const source = [
      "Wrap a procedure in one `<Step>` and give each `<StepItem>` a title.",
      "Never write `<Step title=\"…\">`.",
    ].join("\n");

    expect(findStepProblems(source)).toEqual([]);
  });

  test("reports text and code blocks directly inside Step", () => {
    const problems = findStepProblems(
      ["<Step>", "Install the SDK.", "", "```bash", "npm i sdk", "```", "</Step>"].join("\n"),
    );

    expect(problems.map((problem) => [problem.kind, problem.line])).toEqual([
      ["looseContent", 1],
      ["looseContent", 3],
    ]);
  });

  test("reports props on Step and a StepItem outside Step", () => {
    const problems = findStepProblems(
      [
        '<Step title="A" icon="rocket">',
        '<StepItem title="Inside">Fine.</StepItem>',
        "</Step>",
        "",
        '<StepItem title="Orphan">Lost.</StepItem>',
      ].join("\n"),
    );

    expect(problems.map((problem) => problem.kind)).toEqual(["stepProps", "orphanStepItem"]);
  });
});

describe("validator stepStructure check", () => {
  test("reports <Step title> as a soft issue, and the writer cleanup rewrites that shape", async () => {
    const { body } = parseFrontmatter(await titledStepsPage());
    const quality = checkContentQuality(body);
    const issue = quality.issues.find((candidate) => candidate.check === "stepStructure");

    expect(issue).toMatchObject({ severity: "soft", location: { line: 27 } });
    expect(issue?.fixInstruction).toContain('`<StepItem title="…">`');

    const fixed = normalizeStepBlocks(body);
    expect(checkContentQuality(fixed).issues.map((candidate) => candidate.check)).not.toContain(
      "stepStructure",
    );
  });

  test("reports loose content inside Step as a hard issue the model must rewrite", async () => {
    const page = [
      "---",
      'title: "Deploy"',
      'description: "Deploy the service to production with the CLI."',
      "---",
      "",
      "## Deploy the service",
      "",
      "Follow these steps to ship a release of the service to production safely.",
      "",
      "<Step>",
      "Build the image with the release tag.",
      "",
      "Push the image and roll out the new version.",
      "</Step>",
      "",
      "The rollout finishes when every replica reports healthy to the load balancer.",
    ].join("\n");

    const report = await runPageValidation(page, { mdxCompile: false, minBodyLength: 0 });
    const issue = report.issues.find((candidate) => candidate.rule === "stepStructure");

    expect(report.ok).toBe(false);
    expect(issue).toMatchObject({ severity: "hard", line: 11 });
    expect(issue?.message).toContain("outside a <StepItem>");
  });
});

describe("cleanWriterBody", () => {
  test("rewrites <Step title> before validation, so the writer gate sees valid steps", async () => {
    const cleaned = cleanWriterBody(await titledStepsPage());

    expect(findStepProblems(cleaned)).toEqual([]);
    expect(renderedSteps(cleaned)[0]).toHaveLength(4);
    expect(checkContentQuality(cleaned).issues.map((issue) => issue.check)).not.toContain(
      "stepStructure",
    );
  });
});
