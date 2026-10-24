import { describe, expect, test } from "vitest";
import {
  leadingFrontmatterLength,
  stripAllFrontmatter,
} from "../src/utils/frontmatter";
import {
  markdownSectionText,
  sectionIndexForLine,
  spliceMarkdownSections,
  splitMarkdownSections,
} from "../src/utils/markdown-sections";

function headings(body: string, maxLevel = 2): string[] | undefined {
  return splitMarkdownSections(body, maxLevel)?.sections.map(
    (section) => section.heading,
  );
}

describe("markdown sections", () => {
  test("splits at headings up to the level and keeps deeper headings inside", () => {
    const body = [
      "Lead paragraph.",
      "",
      "# Deploy",
      "",
      "Intro.",
      "",
      "## Install",
      "",
      "Run the installer.",
      "",
      "### Options",
      "",
      "Nested detail.",
      "",
      "## Verify ##",
      "",
      "Check it.",
    ].join("\n");

    const layout = splitMarkdownSections(body, 2);

    expect(layout?.preambleEnd).toBe(2);
    expect(layout?.sections.map(({ heading, level, startLine, endLine }) => ({
      heading,
      level,
      startLine,
      endLine,
    }))).toEqual([
      { heading: "Deploy", level: 1, startLine: 2, endLine: 6 },
      { heading: "Install", level: 2, startLine: 6, endLine: 14 },
      { heading: "Verify", level: 2, startLine: 14, endLine: 17 },
    ]);
    expect(layout && markdownSectionText(layout, layout.sections[1]!)).toBe(
      "## Install\n\nRun the installer.\n\n### Options\n\nNested detail.",
    );
    expect(headings(body, 3)).toEqual(["Deploy", "Install", "Options", "Verify"]);
  });

  test("ignores # lines inside backtick and tilde code fences", () => {
    const body = [
      "## Shell",
      "",
      "```bash",
      "## not a heading",
      "# also a comment",
      "```",
      "",
      "~~~~yaml",
      "## still code",
      "```",
      "## still code after an inner shorter fence",
      "~~~~",
      "",
      "## Next",
    ].join("\n");

    expect(headings(body)).toEqual(["Shell", "Next"]);
  });

  test("ignores headings inside MDX components, including multi-line tags", () => {
    const body = [
      "## Install",
      "",
      "<Tabs>",
      "<Tab title=\"npm > yarn\">",
      "## Inside a tab",
      "</Tab>",
      "<Card",
      "  title=\"Next\"",
      "  href={\"/a>b\"}",
      "/>",
      "</Tabs>",
      "",
      "Use `<Tabs>` for variants and see <https://example.com>.",
      "",
      "<>",
      "## Inside a fragment",
      "</>",
      "",
      "## After",
    ].join("\n");

    expect(headings(body)).toEqual(["Install", "After"]);
  });

  test("refuses to split a body with an open fence or component", () => {
    expect(splitMarkdownSections("## A\n\n```ts\n## B", 2)).toBeNull();
    expect(splitMarkdownSections("## A\n\n<Note>\n\n## B", 2)).toBeNull();
    expect(splitMarkdownSections("## A\n\n</Note>\n\n## B", 2)).toBeNull();
  });

  test("maps body lines to sections and splices replacements", () => {
    const body = "Intro.\n\n## One\n\nFirst.\n\n## Two\n\nSecond.\n";
    const layout = splitMarkdownSections(body, 2);
    if (!layout) throw new Error("Expected a layout.");

    expect(sectionIndexForLine(layout, 0)).toBeNull();
    expect(sectionIndexForLine(layout, 4)).toBe(0);
    expect(sectionIndexForLine(layout, 8)).toBe(1);
    expect(sectionIndexForLine(layout, 99)).toBeNull();
    expect(spliceMarkdownSections(layout, new Map())).toBe(body.trimEnd());
    expect(
      spliceMarkdownSections(layout, new Map([[0, "\n## One\n\nFixed.\n\n"]])),
    ).toBe("Intro.\n\n## One\n\nFixed.\n\n## Two\n\nSecond.");
  });

  test("measures every leading frontmatter block", () => {
    const content = "---\ntitle: A\n---\n---\ntitle: B\n---\n\n# A\n\nBody.\n";
    const length = leadingFrontmatterLength(content);

    expect(content.slice(length)).toBe("# A\n\nBody.\n");
    expect(stripAllFrontmatter(content)).toBe("# A\n\nBody.");
    expect(leadingFrontmatterLength("# No frontmatter")).toBe(0);
  });
});
