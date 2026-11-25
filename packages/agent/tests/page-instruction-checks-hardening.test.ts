/**
 * The owner's page checks stay linear on pathological lines, match case-only
 * term pairs, and find excluded paths in Python, Rust and shell examples.
 */
import { DEFAULT_DOXABOT_INSTRUCTIONS } from "@doxahq/contracts";
import { describe, expect, test } from "vitest";

import {
  addedPageInstructionBreaks,
  checkPageInstructions,
  listPageInstructionBreaksOfPage,
  MAX_CHECKED_LINE_LENGTH,
  pageInstructionRules,
  type PageInstructionRules,
} from "../src/utils/page-instruction-checks";

function rulesWith(overrides: Partial<typeof DEFAULT_DOXABOT_INSTRUCTIONS>): PageInstructionRules {
  return pageInstructionRules({ ...DEFAULT_DOXABOT_INSTRUCTIONS, ...overrides });
}

const allChecks = rulesWith({
  terminology: [{ use: "workspace", avoid: ["org"] }],
  doNotDocument: ["internal/**"],
  codeLanguages: ["python"],
  pageTypes: ["quickstart", "guides", "concepts", "reference"],
});

function codes(body: string, rules: PageInstructionRules): string[] {
  return checkPageInstructions(body, rules).map((issue) => issue.check);
}

/**
 * The time limits below hold on a developer machine. A shared CI runner is
 * slower and noisier, so CI gets three times each limit. A pattern that is
 * quadratic in the line length takes seconds on these lines, so the tests
 * still catch it there.
 */
const TIME_LIMIT_FACTOR = process.env.CI === "true" ? 3 : 1;

/** The time limit for this machine, in ms. */
function limitMs(localMs: number): number {
  return localMs * TIME_LIMIT_FACTOR;
}

/** The fastest of three runs, in ms, so that one run on a busy machine does not count. */
function timed(run: () => void): number {
  let fastest = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now();
    run();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}

describe("the checks stay linear in the line length", () => {
  test.each([
    ["a.", "a. "],
    ["](", "]( "],
    ["x/*", "x/* "],
    ["href={", "value={"],
  ])("a 100 KB line of %s finishes fast", (unit) => {
    const line = unit.repeat(Math.ceil(100_000 / unit.length));
    expect(timed(() => checkPageInstructions(line, allChecks))).toBeLessThan(limitMs(200));
  });

  test.each(["a.", "](", "x/*", "value={"])("many lines just under the limit of %s finish fast", (unit) => {
    const line = unit.repeat(Math.floor((MAX_CHECKED_LINE_LENGTH - 1) / unit.length));
    const body = Array.from({ length: 12 }, () => line).join("\n\n");
    expect(timed(() => checkPageInstructions(body, allChecks))).toBeLessThan(limitMs(400));
  });

  test("a normal line over the limit is not read, a line under it is", () => {
    const long = `Each org has members. ${"More text here. ".repeat(MAX_CHECKED_LINE_LENGTH / 16)}`;
    expect(codes(long, allChecks)).toEqual([]);
    expect(codes("Each org has members.", allChecks)).toEqual(["instructionTerminology"]);
  });

  test("a link and a URL are still left out after the pattern change", () => {
    expect(codes("Read [the guide](https://example.com/org/internal/a.ts) first.", allChecks)).toEqual([]);
    expect(codes("Open https://org.example.com/internal/a.ts to start.", allChecks)).toEqual([]);
  });
});

describe("a term pair that differs only in case", () => {
  const rules = rulesWith({ terminology: [{ use: "GitHub", avoid: ["Github"] }] });

  test("the avoided spelling is found", () => {
    expect(codes("Connect your Github account.", rules)).toEqual(["instructionTerminology"]);
  });

  test("the preferred spelling passes", () => {
    expect(codes("Connect your GitHub account to GitHub Actions.", rules)).toEqual([]);
  });

  test("other pairs still ignore case", () => {
    const caseless = rulesWith({ terminology: [{ use: "workspace", avoid: ["org"] }] });
    expect(codes("Each Org has members.", caseless)).toEqual(["instructionTerminology"]);
  });
});

describe("excluded paths in code examples", () => {
  const rules = rulesWith({ doNotDocument: ["internal/**"] });
  const fence = (language: string, code: string) => ["```" + language, code, "```"].join("\n");

  test.each([
    ["python", "from internal.secret import token"],
    ["python", "import internal.secret"],
    ["python", "import os, internal.secret"],
    ["python", "from .internal.secret import token"],
    ["rust", "use internal::secret;"],
    ["rust", "pub use crate::internal::secret::Token;"],
    ["bash", "cd internal/tools"],
    ["sh", "$ python internal/x.py"],
    ["bash", "node --config=internal/config.json app.js"],
    ["python", "from internal import x"],
    ["python", "import internal"],
    ["python", "import internal.secret as s"],
    ["python", "import os, internal as i  # helpers"],
    ["python", "from .internal import y"],
    ["rust", "use internal::{a, b};"],
    ["rust", "use crate::{internal::secret, other};"],
    ["bash", "docker run -v internal/data:/data app"],
  ])("%s: %s is found", (language, code) => {
    expect(codes(fence(language, code), rules)).toEqual(["instructionExcludedPath"]);
  });

  test.each([
    ["python", "import os\nfrom pathlib import Path"],
    ["rust", "use std::collections::HashMap;"],
    ["bash", "curl -X GET https://api.example.com/internal/users"],
    ["bash", "cd /internal/tools"],
    ["bash", "# cd internal/tools"],
    ["bash", "npm install --save internal"],
    ["ts", "import os from 'node:os';"],
    ["python", "import os.path as osp\nfrom . import helpers\nimport json  # internal use only"],
    ["python", "import internalize"],
    ["rust", "use std::{fs, io};"],
    ["bash", "docker run -v /srv/data:/data app"],
    ["bash", "curl http://localhost:3000/internal/users"],
    ["bash", "curl localhost:3000/internal/users"],
  ])("%s: %s is not found", (language, code) => {
    expect(codes(fence(language, code), rules)).toEqual([]);
  });

  test("an import list is read to its end, not only its first items", () => {
    const modules = [...Array.from({ length: 20 }, (_, index) => `module${index}`), "internal.secret"];
    expect(codes(fence("python", `import ${modules.join(", ")}`), rules)).toEqual(["instructionExcludedPath"]);
    expect(codes(fence("rust", `use crate::{${[...modules.slice(0, 20), "internal::secret"].join(", ")}};`), rules))
      .toEqual(["instructionExcludedPath"]);
  });

  test("an import item with a long run of spaces is skipped, not matched slowly", () => {
    expect(codes(fence("python", `import internal${" ".repeat(400)}secret`), rules)).toEqual([]);
  });

  test("an HTTP route in prose is still not a path", () => {
    expect(codes("Send GET internal/users to list them.", rules)).toEqual([]);
  });
});

describe("breaks for comparing two versions of a page", () => {
  const page = (body: string) => ["---", 'title: "Teams"', 'description: "One shared place."', "---", "", body].join("\n");

  test("every use of a term is its own break", () => {
    const breaks = listPageInstructionBreaksOfPage(page("Each org has members.\n\nAn org has owners."), allChecks);
    expect(breaks).toEqual([
      { check: "instructionTerminology", subject: "org" },
      { check: "instructionTerminology", subject: "org" },
    ]);
  });

  test("the description counts", () => {
    const withDescription = page("Each workspace has members.").replace("One shared place.", "One org.");
    expect(listPageInstructionBreaksOfPage(withDescription, allChecks)).toEqual([
      { check: "instructionTerminology", subject: "org" },
    ]);
  });

  test("only breaks beyond the earlier version count as added", () => {
    const before = [{ check: "instructionTerminology" as const, subject: "org" }];
    const after = [
      { check: "instructionTerminology" as const, subject: "org" },
      { check: "instructionExcludedPath" as const, subject: "internal/a.ts" },
    ];
    expect(addedPageInstructionBreaks(before, after)).toEqual([after[1]]);
    expect(addedPageInstructionBreaks(after, before)).toEqual([]);
  });
});

describe("import and shell path checks stay bounded on long lines", () => {
  const rules = rulesWith({ doNotDocument: ["internal/**"] });
  const nearCap = (text: string) => text.slice(0, MAX_CHECKED_LINE_LENGTH - 100);

  test.each([
    ["python", nearCap("import " + "a.".repeat(5_000))],
    ["python", nearCap("import " + "a.b, ".repeat(1_600))],
    ["rust", nearCap("use " + "a::".repeat(2_000) + "{" + "b,".repeat(1_000)) + "}"],
    ["rust", "use " + "a::".repeat(50) + "{" + "b::c,".repeat(1_400) + "}"],
    ["bash", nearCap("docker -v " + "a:".repeat(5_000)) + "/x"],
    ["bash", nearCap("cd " + "a/".repeat(4_000))],
    ["python", "import a" + " ".repeat(7_900) + "b"],
    ["python", "import a," + `x${" ".repeat(400)}y,`.repeat(19)],
    ["rust", "use base::{a" + " ".repeat(7_900) + "b}"],
    ["python", nearCap("import " + Array.from({ length: 2_000 }, (_, index) => `m${index}`).join(", "))],
  ])("20 long %s lines", (language, line) => {
    const body = Array.from({ length: 20 }, () => ["```" + language, line, "```"].join("\n")).join("\n\n");

    expect(timed(() => checkPageInstructions(body, rules))).toBeLessThan(limitMs(400));
  });
});

describe("adversarial import and heading lines stay linear", () => {
  const rules = rulesWith({ doNotDocument: ["internal/**"], pageTypes: ["quickstart", "guides", "concepts", "reference"] });
  const line8k = (text: string) => text.slice(0, MAX_CHECKED_LINE_LENGTH - 10);
  const fenced = (language: string, line: string) =>
    Array.from({ length: 20 }, () => ["```" + language, line, "```"].join("\n")).join("\n\n");

  test.each([
    ["a from import of dots with no import", "python", line8k("from " + ".".repeat(7_990) + "x")],
    ["many short import items", "python", line8k("import " + "a, ".repeat(2_700))],
    ["a long group of repeated members", "rust", line8k("use base::{" + "b, ".repeat(2_700)) + "}"],
  ])("20 lines of %s finish in under 200 ms", (_name, language, line) => {
    const body = fenced(language, line);

    expect(timed(() => checkPageInstructions(body, rules))).toBeLessThan(limitMs(200));
  });

  test("20 headings with a long run of inner spaces finish in under 200 ms", () => {
    const body = Array.from({ length: 20 }, () => line8k("## a" + " ".repeat(7_990) + "b")).join("\n\n");

    expect(timed(() => checkPageInstructions(body, rules))).toBeLessThan(limitMs(200));
  });

  test("the from import and heading checks still find what they did", () => {
    const python = ["```python", "from .internal.secret import key", "from . import sibling", "```"].join("\n");
    expect(codes(python, rules)).toEqual(["instructionExcludedPath"]);
    expect(codes("## Troubleshooting   ", rules)).toEqual(["instructionPageType"]);
    expect(codes("## Getting help", rules)).toEqual([]);
  });
});

