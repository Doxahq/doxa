import React, { type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/src/lib/transition", async () => {
  const react = await import("react");

  return {
    Link: ({
      href,
      className,
      children,
    }: {
      href: string;
      className?: string;
      children: ReactNode;
    }) =>
      react.createElement(
        "a",
        { href, className, "data-router-link": "true" },
        children
      ),
  };
});

import RoutedLink from "./link";

describe("RoutedLink", () => {
  test("renders a hash-only link as a plain same-page anchor", () => {
    const html = renderToString(
      React.createElement(RoutedLink, {
        href: "#commands",
        children: "Commands",
      })
    );

    expect(html).toBe('<a href="#commands">Commands</a>');
  });

  test("renders an internal path through the application router", () => {
    const html = renderToString(
      React.createElement(RoutedLink, { href: "/guide", children: "Guide" })
    );

    expect(html).toBe(
      '<a href="/guide" data-router-link="true">Guide</a>'
    );
  });

  test("renders an external URL in a new browser tab", () => {
    const html = renderToString(
      React.createElement(
        RoutedLink,
        { href: "https://example.com", children: "Example" }
      )
    );

    expect(html).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">Example</a>'
    );
  });
  test("passes a class to the anchor, so a card can turn off the prose underline", () => {
    for (const href of ["#top", "/guide", "https://doxa.so"]) {
      const html = renderToString(
        React.createElement(RoutedLink, {
          href,
          className: "no-underline!",
          children: "Card",
        })
      );
      expect(html).toMatch(/^<a [^>]*class="no-underline!"/);
    }
  });
});
