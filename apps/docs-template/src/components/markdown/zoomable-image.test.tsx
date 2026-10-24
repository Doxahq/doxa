import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { RuntimeMdxContent } from "@doxahq/docs-prose";
import { parseRuntimeMdx } from "@doxahq/mdx-runtime";

import { components, elements } from "@/src/lib/components";

function render(source: string): string {
  return renderToStaticMarkup(
    createElement(RuntimeMdxContent, {
      document: parseRuntimeMdx(source),
      components,
      elements,
    }),
  );
}

describe("page images", () => {
  test("render as a keyboard-reachable button that opens the viewer", () => {
    const html = render("![Rate limits](/assets/rate-limits.png)\n");

    expect(html).toContain('src="/assets/rate-limits.png"');
    expect(html).toContain('alt="Rate limits"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="Enlarge image: Rate limits"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("cursor-zoom-in");
  });

  test("render no viewer until the reader opens one", () => {
    expect(render("![a](/assets/a.png)\n")).not.toContain('role="dialog"');
  });
});
