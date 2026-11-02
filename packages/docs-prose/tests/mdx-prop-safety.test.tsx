import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, test } from "vitest";
import { parseRuntimeMdx } from "@doxahq/mdx-runtime";

import { createProseComponents } from "../src/components/registry";
import { safeMdxProps, withoutPositioningClasses } from "../src/render/mdx-prop-safety";
import { RuntimeMdxContent } from "../src/render/runtime-mdx-content";

/** SECURITY REGRESSION GUARDRAIL (SEC-009): MDX cannot lift content over the page. */
describe("MDX prop safety", () => {
  test.each([
    ["fixed inset-0 z-50 bg-background", "bg-background"],
    ["md:fixed hover:!-top-4 lg:z-[999] p-4", "p-4"],
    ["absolute sticky left-0 right-[10%] inset-x-0 start-2 end-2", ""],
    ["[position:fixed] md:[z-index:9] rounded-lg", "rounded-lg"],
    ["pt-5 pb-1 relative bg-[url(https://example.com/a.png)]", "pt-5 pb-1 relative bg-[url(https://example.com/a.png)]"],
    ["text-left top-tip", "text-left"],
  ])("keeps only safe classes of %j", (className, expected) => {
    expect(withoutPositioningClasses(className)).toBe(expected);
  });

  test("drops a string style and keeps every other prop", () => {
    expect(safeMdxProps({ title: "Go", style: "position:fixed;inset:0", href: "/x", className: "z-50 p-2" })).toEqual({
      title: "Go",
      href: "/x",
      className: "p-2",
    });
  });

  test("renders a card without the overlay classes", () => {
    const document = parseRuntimeMdx(
      '<Card title="Session expired" href="https://evil.example/login" className="fixed inset-0 z-50 bg-background" />\n',
    );
    const html = renderToStaticMarkup(
      createElement(RuntimeMdxContent, { document, components: createProseComponents() }),
    );

    expect(html).not.toMatch(/\bfixed\b|\binset-0\b|\bz-50\b/);
    expect(html).toContain("bg-background");
  });
});
