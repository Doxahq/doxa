import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";

import Pre from "./pre";

describe("documentation code block", () => {
  test("shows the current language next to the copy control", () => {
    const html = renderToString(
      React.createElement(
        Pre,
        { raw: "const ready = true;", "data-language": "typescript" },
        React.createElement("code", null, "const ready = true;")
      )
    );

    expect(html).toContain('data-code-language="true"');
    expect(html).toContain(">typescript</span>");
    expect(html.indexOf(">typescript</span>")).toBeLessThan(
      html.indexOf('aria-label="Copy to clipboard"')
    );
  });

  test("does not render an empty language label", () => {
    const html = renderToString(
      React.createElement(
        Pre,
        { raw: "plain output" },
        React.createElement("code", null, "plain output")
      )
    );

    expect(html).not.toContain('data-code-language="true"');
  });

  test("does not render a broken copy control without source text", () => {
    const html = renderToString(
      React.createElement(
        Pre,
        { "data-language": "text" },
        React.createElement("code", null, "visible code")
      )
    );

    expect(html).not.toContain('aria-label="Copy to clipboard"');
  });
});
