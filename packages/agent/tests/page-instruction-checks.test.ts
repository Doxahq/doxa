import { DEFAULT_DOXABOT_INSTRUCTIONS, type DoxabotInstructions } from "@doxahq/contracts";
import { describe, expect, test } from "vitest";

import {
  checkPageInstructions,
  checkPageInstructionsOfPage,
  pageInstructionRules,
} from "../src/utils/page-instruction-checks";
import { runPageValidation } from "../src/utils/page-validator";

function rulesWith(overrides: Partial<DoxabotInstructions>) {
  return pageInstructionRules({ ...DEFAULT_DOXABOT_INSTRUCTIONS, ...overrides });
}

function codesFor(overrides: Partial<DoxabotInstructions>) {
  const rules = rulesWith(overrides);
  return (body: string) => checkPageInstructions(body, rules).map((issue) => issue.check);
}

describe("terminology (L2)", () => {
  const codes = codesFor({ terminology: [{ use: "repository", avoid: ["repo"] }, { use: "workspace", avoid: ["org"] }] });

  test.each([
    ["a plural", "Clone both repos first.\n"],
    ["a plural of the second entry", "Invite your orgs.\n"],
    ["a term wrapped across two lines", "Pick the\nrepo that you want.\n"],
  ])("finds %s", (_name, body) => {
    expect(codes(body)).toEqual(["instructionTerminology"]);
  });

  test("finds a multi-word term split over a line break", () => {
    const local = codesFor({ terminology: [{ use: "workspace", avoid: ["project space"] }] });

    expect(local("Open the project\nspace settings.\n")).toEqual(["instructionTerminology"]);
    expect(local("Open the project.\n\nSpace is free.\n")).toEqual([]);
  });

  test("points at the line of a wrapped term", () => {
    const [issue] = checkPageInstructions("First line.\nSecond line names a\nrepo here.\n", rulesWith({
      terminology: [{ use: "repository", avoid: ["repo"] }],
    }));

    expect(issue?.location?.line).toBe(2);
  });

  test("the plural of the term to use is no break", () => {
    expect(codes("Both repositories are ready.\n")).toEqual([]);
  });

  test("finds a term in the frontmatter description", () => {
    const rules = rulesWith({ terminology: [{ use: "repository", avoid: ["repo"] }] });
    const page = "---\ntitle: \"Setup\"\ndescription: \"Connect your repo to Doxa.\"\n---\n\nConnect the repository.\n";

    expect(checkPageInstructionsOfPage(page, rules).map((issue) => issue.check)).toEqual(["instructionTerminology"]);
  });

  test("the validator checks the description too", async () => {
    const rules = rulesWith({ terminology: [{ use: "repository", avoid: ["repo"] }] });
    const page = [
      "---",
      "title: \"Setup\"",
      "description: \"Connect your repo to Doxa in a few steps.\"",
      "---",
      "",
      "## Connect",
      "",
      "Connect the repository from the dashboard, then choose the branch that Doxa reads.",
      "",
      "Doxa reads the default branch and writes the docs from what it finds in the code.",
    ].join("\n");

    const report = await runPageValidation(page, { mdxCompile: false, instructionRules: rules });
    expect(report.issues.map((issue) => issue.rule)).toContain("instructionTerminology");
  });

  test.each([
    ["an icon prop", "<Card icon=\"repo\" title=\"Source\">\n"],
    ["a value prop", "<TabsTrigger value=\"repo\">Source</TabsTrigger>\n"],
    ["a className", "<div className=\"repo-card\">Source</div>\n"],
    ["an MDX comment", "{/* keep the repo wording from the seed */}\n"],
    ["an HTML comment", "<!-- the repo page -->\n"],
    ["a comment over lines", "{/*\nrepo\n*/}\nText.\n"],
    ["a four-backtick fence with a nested fence", "````md\n```ts\nconst x = 1;\n```\nrepo\n````\n"],
  ])("ignores %s", (_name, body) => {
    expect(codes(body)).toEqual([]);
  });

  test("a fence closes only on the same marker", () => {
    expect(codes("~~~\n```\nrepo\n~~~\nThe repo.\n")).toEqual(["instructionTerminology"]);
    expect(codes("~~~\n```\nrepo\n```\nstill code\n~~~\n")).toEqual([]);
  });

  test("a visible title prop still counts", () => {
    expect(codes("<Card icon=\"book\" title=\"Your repo\">\n")).toEqual(["instructionTerminology"]);
  });
});

describe("code languages (L3)", () => {
  const codes = codesFor({ codeLanguages: ["typescript", "python"] });
  const fence = (language: string) => [`\`\`\`${language}`, "x", "```"].join("\n");

  test("a nested <Tabs> closing does not end the outer group", () => {
    const body = [
      "<Tabs>",
      "<Tabs>",
      fence("ts"),
      "</Tabs>",
      fence("python"),
      fence("ts"),
      "</Tabs>",
    ].join("\n");

    expect(codes(body)).toEqual(["instructionCodeLanguage"]);
  });

  test("an outer group in the owner's order passes around a nested group", () => {
    const body = ["<Tabs>", fence("ts"), "<Tabs>", fence("ts"), "</Tabs>", fence("python"), "</Tabs>"].join("\n");

    expect(codes(body)).toEqual([]);
  });

  test("reads a fence language with line highlights", () => {
    expect(codes(["<Tabs>", fence("py{1}"), fence("ts {2-3}"), "</Tabs>"].join("\n"))).toEqual(["instructionCodeLanguage"]);
  });

  test("a shell fence counts as cURL when any command runs curl", () => {
    const local = codesFor({ codeLanguages: ["python", "curl"] });
    const shell = ["```bash", "# Send the request", "export TOKEN=abc", "curl https://api.example.com", "```"].join("\n");

    expect(local(["<Tabs>", shell, fence("python"), "</Tabs>"].join("\n"))).toEqual(["instructionCodeLanguage"]);
    expect(local(["<Tabs>", fence("python"), shell, "</Tabs>"].join("\n"))).toEqual([]);
  });

  test("a commented-out curl is not cURL", () => {
    const local = codesFor({ codeLanguages: ["python", "curl"] });
    const shell = ["```bash", "# curl https://api.example.com", "npm start", "```"].join("\n");

    expect(local(["<Tabs>", shell, fence("python"), "</Tabs>"].join("\n"))).toEqual([]);
  });
});

describe("excluded paths (L4)", () => {
  const codes = codesFor({ doNotDocument: ["internal/**", "INTERNAL.md"] });

  test.each([
    ["a folder in inline code", "Keep `internal/` private.\n"],
    ["a single excluded file", "Read INTERNAL.md first.\n"],
    ["a single excluded file in inline code", "Read `INTERNAL.md` first.\n"],
    ["a path in prose", "See internal/billing/plan.ts for details.\n"],
    ["a relative import", "```ts\nimport { plan } from \"../internal/billing\";\n```\n"],
    ["a require call", "```js\nconst plan = require(\"./internal/plan\");\n```\n"],
  ])("finds %s", (_name, body) => {
    expect(codes(body)).toEqual(["instructionExcludedPath"]);
  });

  test.each([
    ["a route after a method", "Call GET internal/users to list them.\n"],
    ["a route with a leading slash", "Call GET /internal/users to list them.\n"],
    ["a route in inline code", "Call `GET /internal/users`.\n"],
    ["a URL", "See https://x.dev/internal/a.\n"],
    ["another folder with the same name inside", "See src/internal/plan.ts.\n"],
    ["a package import", "```ts\nimport { z } from \"zod\";\n```\n"],
  ])("ignores %s", (_name, body) => {
    expect(codes(body)).toEqual([]);
  });

  test("a folder glob with a wildcard finds a folder mention", () => {
    const local = codesFor({ doNotDocument: ["packages/*/private/**"] });

    expect(local("The `packages/core/private/` folder holds keys.\n")).toEqual(["instructionExcludedPath"]);
  });
});

describe("page type sections", () => {
  const codes = codesFor({ pageTypes: ["quickstart", "guides", "reference", "concepts"] });

  test("finds a troubleshooting or FAQ section", () => {
    expect(codes("## Troubleshooting\n\nText.\n")).toEqual(["instructionPageType"]);
    expect(codes("## FAQ\n\nText.\n")).toEqual(["instructionPageType"]);
  });

  test("keeps the common errors of an API page", () => {
    expect(codes("## Common errors\n\nThe API returns 404 when the page is missing.\n")).toEqual([]);
  });

  test("ignores a heading inside a comment", () => {
    expect(codes("{/* ## Troubleshooting */}\n\nText.\n")).toEqual([]);
  });
});
