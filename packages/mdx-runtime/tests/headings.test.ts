import { describe, expect, it } from "vitest";

import { headingSlug, parseRuntimeMdx, runtimeMdxHeadings } from "../src";
import type { RuntimeMdxElementNode } from "../src";

function headingIds(source: string): string[] {
  return parseRuntimeMdx(source)
    .nodes.filter((node): node is RuntimeMdxElementNode => node.type === "element" && /^h\d$/.test(node.name))
    .map((node) => String(node.props?.id));
}

describe("heading anchors", () => {
  it("gives every heading an id from its text", () => {
    expect(headingIds("## Start with service checks\n\n### A repeatable diagnosis\n")).toEqual([
      "start-with-service-checks",
      "a-repeatable-diagnosis",
    ]);
  });

  it("makes a repeated heading unique", () => {
    expect(headingIds("## Symptoms\n\n## Fixes\n\n## Symptoms\n\n## Symptoms\n")).toEqual([
      "symptoms",
      "fixes",
      "symptoms-1",
      "symptoms-2",
    ]);
  });

  it("reads the text of inline code, links and emphasis, and drops punctuation", () => {
    expect(headingIds("## “Used before init” behavior\n\n## The `init()` call and [links](/x)\n")).toEqual([
      "used-before-init-behavior",
      "the-init-call-and-links",
    ]);
  });

  it("keeps letters of every script", () => {
    expect(headingSlug("Résumé des étapes")).toBe("résumé-des-étapes");
  });

  it("finds headings inside components and ignores code blocks", () => {
    const document = parseRuntimeMdx(
      ['<Note title="Tip">', "", "## Inside a note", "", "</Note>", "", "```md", "## Not a heading", "```", ""].join("\n"),
    );
    expect(runtimeMdxHeadings(document.nodes)).toEqual([
      { level: 2, text: "Inside a note", href: "#inside-a-note" },
    ]);
  });

  it("lists levels 2 to 4 for the table of contents, with the rendered anchors", () => {
    const document = parseRuntimeMdx("# Title\n\n## Setup\n\n### Install\n\n##### Deep\n\n## Setup\n");
    expect(runtimeMdxHeadings(document.nodes)).toEqual([
      { level: 2, text: "Setup", href: "#setup" },
      { level: 3, text: "Install", href: "#install" },
      { level: 2, text: "Setup", href: "#setup-1" },
    ]);
  });
});
