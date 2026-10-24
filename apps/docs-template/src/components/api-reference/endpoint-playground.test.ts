import { createElement } from "react";
import { getDocsHighlighter } from "@doxahq/mdx-runtime/highlight";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  loadSessionAuthToken,
  saveSessionAuthToken,
} from "@/src/lib/api-request";
import {
  EndpointPlayground,
  EndpointPlaygroundResponse,
} from "@/src/components/api-reference/endpoint-playground";
import Copy from "@/src/components/markdown/copy";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("endpoint playground authorization", () => {
  test("renders a live JSON response with shared Shiki highlighting", () => {
    const html = renderToString(
      createElement(EndpointPlaygroundResponse, {
        body: '{"status":"ready","count":2}',
        contentType: "application/json; charset=utf-8",
        highlighter: getDocsHighlighter(),
      })
    );

    expect(html).toContain("shiki");
    expect(html).toContain('data-language="json"');
    expect(html).toContain("--shiki-light");
    expect(html).toContain("--shiki-dark");
    expect(html).toContain("&quot;status&quot;");
    expect(html).toContain("\n");
  });

  test("renders a plain response while the playground highlighter loads", () => {
    const html = renderToString(
      createElement(EndpointPlaygroundResponse, {
        body: '{"status":"ready"}',
        contentType: "application/json",
        highlighter: null,
      })
    );

    expect(html).not.toContain("shiki");
    expect(html).toContain('data-language="json"');
    expect(html).toContain("&quot;status&quot;");
  });

  test("keeps a plain-text response visible without a highlighting error", () => {
    expect(() =>
      renderToString(
        createElement(EndpointPlaygroundResponse, {
          body: "Service temporarily unavailable",
          contentType: "text/plain; charset=utf-8",
          highlighter: null,
        })
      )
    ).not.toThrow();

    const html = renderToString(
      createElement(EndpointPlaygroundResponse, {
        body: "Service temporarily unavailable",
        contentType: "text/plain; charset=utf-8",
        highlighter: null,
      })
    );
    expect(html).toContain("Service temporarily unavailable");
    expect(html).toContain('data-language="text"');
  });

  test("makes the complete request row copy the request URL", () => {
    const html = renderToString(
      createElement(EndpointPlayground, {
        method: "GET",
        path: "/messages",
        baseUrl: "https://api.example.com",
        parameters: [],
      })
    );

    expect(html).toContain('aria-label="Copy request URL"');
    expect(html).toContain('type="button"');
    expect(html).toContain("https://api.example.com/messages");
  });

  test("anchors copy icons inside their button", () => {
    const html = renderToString(createElement(Copy, { content: "sample" }));

    expect(html).toContain('data-copy-icon-container="true"');
    expect(html).toContain("relative size-3.5");
  });

  test("shows authorization before the other request parameters", () => {
    const html = renderToString(
      createElement(EndpointPlayground, {
        method: "GET",
        path: "/messages",
        baseUrl: "https://api.example.com",
        parameters: [
          {
            name: "include",
            type: "string",
            location: "query",
            required: false,
          },
          {
            name: "Authorization",
            type: "bearer",
            location: "header",
            required: true,
          },
        ],
      })
    );

    expect(html.indexOf(">Authorization<")).toBeLessThan(
      html.indexOf(">Parameters<")
    );
  });

  test("shows a fixed Bearer prefix for bearer tokens", () => {
    const html = renderToString(
      createElement(EndpointPlayground, {
        method: "GET",
        path: "/messages",
        baseUrl: "https://api.example.com",
        parameters: [
          {
            name: "Authorization",
            type: "bearer",
            location: "header",
            required: true,
          },
        ],
      })
    );

    expect(html).toContain('data-auth-prefix="Bearer"');
    expect(html).toContain('type="text"');
    expect(html).not.toContain("masked-field");
    const prefixClasses = html.match(
      /data-auth-prefix="Bearer" class="([^"]*)"/
    )?.[1];
    expect(prefixClasses?.split(" ")).not.toContain("border-r");
  });

  test("stores the authorization token for the browser session", () => {
    const values = new Map<string, string>();
    const sessionStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const localStorage = {
      getItem: () => {
        throw new Error("localStorage must not be read");
      },
      setItem: () => {
        throw new Error("localStorage must not be written");
      },
      removeItem: () => {
        throw new Error("localStorage must not be written");
      },
    };
    vi.stubGlobal("window", {
      location: { host: "docs.example.com" },
      sessionStorage,
      localStorage,
    });

    saveSessionAuthToken("secret");

    expect(loadSessionAuthToken()).toBe("secret");

    saveSessionAuthToken("");
    expect(loadSessionAuthToken()).toBe("");
  });
});
