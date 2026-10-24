import { describe, expect, test } from "vitest";
import { parseRuntimeMdx, type RuntimeMdxElementNode } from "@doxahq/mdx-runtime";

import {
  isComponentOnlyParagraph,
  unwrapComponentParagraph,
} from "../src/render/normalize";

function firstParagraph(source: string): RuntimeMdxElementNode {
  const paragraph = parseRuntimeMdx(source).nodes.find(
    (node): node is RuntimeMdxElementNode =>
      node.type === "element" && node.name === "p",
  );
  if (!paragraph) throw new Error("Expected the source to produce a paragraph.");
  return paragraph;
}

describe("component-only paragraphs", () => {
  test("detects a paragraph that holds only block components", () => {
    const paragraph = firstParagraph(
      [
        '<StepItem title="Install">Add it.</StepItem>',
        '<StepItem title="Run">Run it.</StepItem>',
      ].join("\n"),
    );

    expect(isComponentOnlyParagraph(paragraph)).toBe(true);
    // One child per component: `<Step>` numbers its items by counting them.
    expect(unwrapComponentParagraph(paragraph)).toHaveLength(2);
  });

  test("keeps a paragraph that mixes prose with a component", () => {
    expect(isComponentOnlyParagraph(firstParagraph("See <Note>this</Note> for details."))).toBe(
      false,
    );
  });

  test("keeps a paragraph of plain prose", () => {
    expect(isComponentOnlyParagraph(firstParagraph("Just a sentence."))).toBe(false);
  });

  test("keeps a paragraph whose only element is a link", () => {
    expect(isComponentOnlyParagraph(firstParagraph("[the API](https://example.com)"))).toBe(
      false,
    );
  });

  test("drops the newlines between the components", () => {
    const paragraph = firstParagraph(
      [
        '<Card title="One">a</Card>',
        '<Card title="Two">b</Card>',
        '<Card title="Three">c</Card>',
      ].join("\n"),
    );

    const unwrapped = unwrapComponentParagraph(paragraph);
    expect(unwrapped).toHaveLength(3);
    expect(unwrapped.every((node) => node.type === "element")).toBe(true);
  });

  test("leaves self-closing components alone: MDX already makes them blocks", () => {
    const nodes = parseRuntimeMdx(
      ['<Card title="One" />', '<Card title="Two" />'].join("\n"),
    ).nodes;

    expect(nodes.filter((node) => node.type === "element" && node.name === "p")).toHaveLength(0);
    expect(nodes.filter((node) => node.type === "element" && node.name === "Card")).toHaveLength(2);
  });
});
