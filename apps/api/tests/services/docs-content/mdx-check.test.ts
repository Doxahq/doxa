import { validationIssueSchema } from "@doxahq/site-config";
import { describe, expect, it } from "vitest";

import { checkMdxSource } from "../../../src/services/docs-content/mdx-check";

function onlyIssue(source: string) {
  const issues = checkMdxSource(source);
  expect(issues).toHaveLength(1);
  const [issue] = issues;
  expect(validationIssueSchema.safeParse(issue).success).toBe(true);
  return issue;
}

describe("checkMdxSource", () => {
  it("accepts MDX that uses a known component", () => {
    expect(
      checkMdxSource("# Setup\n\n<Note>Install the CLI first.</Note>\n"),
    ).toEqual([]);
  });

  it("accepts a page with frontmatter only", () => {
    expect(checkMdxSource("---\ntitle: Empty page\n---\n")).toEqual([]);
  });

  it("rejects an unknown component", () => {
    const issue = onlyIssue("# Setup\n\n<Bogus>Hello</Bogus>\n");

    expect(issue).toMatchObject({
      path: "",
      code: "mdx_invalid",
      severity: "error",
      params: { reason: "Unknown MDX component: Bogus" },
    });
    expect(issue.message).toContain("Unknown MDX component: Bogus");
  });

  it("points at the first use of an unknown component", () => {
    const issue = onlyIssue(
      "---\ntitle: Setup\n---\n\n```mdx\n<Bogus />\n```\n\nText <Bogus>Hi</Bogus>\n",
    );

    expect(issue.params).toMatchObject({ line: 9, column: 6 });
    expect(issue.message).toContain("at line 9, column 6");
  });

  it("reports the line and column of an unclosed tag", () => {
    const issue = onlyIssue("# Setup\n\n<Note>Hello\n");

    expect(issue.params).toMatchObject({ line: 3, column: 1 });
    expect(issue.message).toContain("at line 3, column 1");
    expect(issue.message).toContain("Expected a closing tag for `<Note>`");
    expect(issue.message).not.toMatch(/\(\d+:\d+/);
  });

  it("reports a bad JSX expression", () => {
    const issue = onlyIssue("# Setup\n\n{1 +}\n");

    expect(issue.params).toMatchObject({ line: 3, column: 5 });
    expect(issue.message).toContain("Could not parse expression with acorn");
  });

  it("counts frontmatter lines in the reported position", () => {
    const issue = onlyIssue("---\ntitle: Setup\n---\n# Setup\n\n<Note>Hello\n");

    expect(issue.params).toMatchObject({ line: 6, column: 1 });
  });

  it("caps the message at 300 characters", () => {
    const longName = `Bogus${"X".repeat(400)}`;
    const issue = onlyIssue(`<${longName}>Hello</${longName}>\n`);

    expect(issue.message.length).toBeLessThanOrEqual(300);
    expect(issue.message).toContain("…");
  });
});
