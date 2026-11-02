import { describe, expect, test } from "vitest";

import {
  parseRuntimeMdx,
  type RuntimeMdxElementNode,
  type RuntimeMdxNode,
} from "../src";

function elements(nodes: readonly RuntimeMdxNode[]): RuntimeMdxElementNode[] {
  return nodes.flatMap((node) =>
    node.type === "element" ? [node, ...elements(node.children ?? [])] : [],
  );
}

function hrefOf(source: string, name: string): RuntimeMdxElementNode["props"] {
  return elements(parseRuntimeMdx(source).nodes).find((node) => node.name === name)?.props;
}

/** A Markdown link in angle brackets, so its destination can hold a tab or a control character. */
function markdownLinkHref(destination: string) {
  return hrefOf(`[link](<${destination}>)`, "a")?.href;
}

/** The raw value goes in the attribute: an MDX attribute string does not decode `\t`. */
function cardHref(href: string) {
  return hrefOf(`<Card title="Guide" href="${href}" />`, "Card")?.href;
}

const UNSAFE_LINKS = [
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "java\tscript:alert(1)",
  "\u0001javascript:alert(1)",
  "data:text/html,x",
  "vbscript:x",
  "//evil.example",
  "/\\evil.example",
];

describe("markdown links", () => {
  test.each(UNSAFE_LINKS)("replace the unsafe link %j with #", (destination) => {
    expect(markdownLinkHref(destination)).toBe("#");
  });

  test.each(["/guide", "#install", "https://doxa.so", "HTTP://doxa.so", "mailto:team@doxa.so"])(
    "keep the safe link %j",
    (destination) => {
      expect(markdownLinkHref(destination)).toBe(destination);
    },
  );

  test("still replace a relative link with #, as before", () => {
    expect(markdownLinkHref("guide")).toBe("#");
  });
});

describe("component href props", () => {
  test.each(UNSAFE_LINKS)("replace the unsafe href %j with #", (href) => {
    expect(cardHref(href)).toBe("#");
  });

  test.each(["/guide", "./guide", "../guide", "guide", "#install", "?tab=1", "https://doxa.so", "mailto:team@doxa.so"])(
    "keep the safe href %j",
    (href) => {
      expect(cardHref(href)).toBe(href);
    },
  );

  test("leave a component without an href unchanged", () => {
    expect(hrefOf(`<Card title="Guide" />`, "Card")).toEqual({ title: "Guide" });
  });
});
