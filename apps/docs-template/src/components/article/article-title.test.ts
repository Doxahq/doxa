import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { ArticleTitle } from "@/src/components/article/article-title";

describe("REST endpoint article title", () => {
  test("renders the method badge before the plain title", () => {
    const markup = renderToStaticMarkup(
      createElement(ArticleTitle, { title: "Get a user", apiMethod: "GET" })
    );

    expect(markup).toMatch(/>GET<\/span>.*Get a user/);
    expect(markup).not.toContain("GET Get a user");
  });

  test("renders an unchanged H1 when method metadata is absent", () => {
    const markup = renderToStaticMarkup(
      createElement(ArticleTitle, { title: "Quickstart" })
    );

    expect(markup).toContain(">Quickstart</h1>");
    expect(markup).not.toContain("method");
  });
});
