import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { DocsIcon, resolveDocsIcon } from "./docs-icon";

function draw(name: string | undefined, className?: string): string {
  return renderToStaticMarkup(createElement(DocsIcon, { name, className }));
}

describe("DocsIcon", () => {
  test("draws a suggested icon from the bundle", () => {
    expect(draw("rocket", "size-4")).toMatch(
      /^<svg [^>]*class="size-4"[^>]*><path /
    );
  });

  test("draws an old suggested name with the current glyph", () => {
    expect(draw("circleHelp")).toContain("<circle");
  });

  test("draws nothing for an icon the route did not send", () => {
    expect(draw("anchor")).toBe("");
    expect(draw(undefined)).toBe("");
  });
});

describe("resolveDocsIcon", () => {
  test("gives each name one stable component, so cards keep their icon", () => {
    expect(resolveDocsIcon("book-open")).toBe(resolveDocsIcon("bookOpen"));
    expect(resolveDocsIcon("anchor")).not.toBe(resolveDocsIcon("bookOpen"));
    expect(resolveDocsIcon("not an icon!")).toBeNull();
  });
});
