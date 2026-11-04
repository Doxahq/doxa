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

  test("draws the response after the code sample, because its height changes", () => {
    const html = renderToString(
      createElement(EndpointPlayground, {
        method: "GET",
        path: "/messages",
        baseUrl: "https://api.example.com",
        parameters: [],
      })
    );

    const sample = html.indexOf(">Code sample<");
    const response = html.indexOf(">Response<");
    expect(sample).toBeGreaterThan(-1);
    expect(response).toBeGreaterThan(sample);
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
      html.indexOf(">Query<")
    );
  });

  test("shows a fixed Bearer prefix for bearer tokens, with the key masked", () => {
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
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="new-password"');
    const prefixClasses = html.match(
      /data-auth-prefix="Bearer" class="([^"]*)"/
    )?.[1];
    expect(prefixClasses?.split(" ")).not.toContain("border-r");
  });

  // The old text is false when the proxy sends the request.
  test("never says that the key stays away from the server", () => {
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

    expect(html).not.toContain("never reaches");
    expect(html).toContain("Use a test key. Kept in this tab only.");
  });

  test("makes no request on render", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    renderToString(
      createElement(EndpointPlayground, {
        method: "DELETE",
        path: "/messages/1",
        baseUrl: "https://api.example.com",
        parameters: [],
      })
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("warns before a request that can change data, and not before a read", () => {
    const render = (method: string) =>
      renderToString(
        createElement(EndpointPlayground, {
          method,
          path: "/messages",
          baseUrl: "https://api.example.com",
          parameters: [],
        })
      );

    expect(render("POST")).toContain("This request can change real data.");
    expect(render("GET")).not.toContain("This request can change real data.");
  });

  test("draws typed inputs from the page's props", () => {
    const html = renderToString(
      createElement(EndpointPlayground, {
        method: "GET",
        path: "/messages",
        baseUrl: "https://api.example.com",
        parameters: [
          {
            name: "order",
            type: "string",
            location: "query",
            required: true,
            enumValues: ["asc", "desc"],
          },
          { name: "limit", type: "integer", location: "query", required: true },
          { name: "pinned", type: "boolean", location: "query", required: true },
          {
            name: "tag",
            type: "string",
            location: "query",
            required: true,
            example: "docs",
          },
        ],
      })
    );

    expect(html).toContain('<option value="asc">asc</option>');
    expect(html).toContain('type="number"');
    expect(html).toContain('<option value="true">true</option>');
    expect(html).toContain('value="docs"');
  });

  test("keeps old pages working with plain text inputs", () => {
    const html = renderToString(
      createElement(EndpointPlayground, {
        method: "GET",
        path: "/messages",
        baseUrl: "https://api.example.com",
        parameters: [
          { name: "q", type: "string", location: "query", required: true },
        ],
      })
    );

    expect(html).toContain('name="q"');
    expect(html).toContain('type="text"');
    expect(html).not.toContain('<option value="">');
  });

  test("hides optional fields behind a chip that names them", () => {
    const html = renderToString(
      createElement(EndpointPlayground, {
        method: "GET",
        path: "/messages",
        baseUrl: "https://api.example.com",
        parameters: [
          { name: "id", type: "string", location: "query", required: true },
          { name: "limit", type: "integer", location: "query", required: false },
          { name: "order", type: "string", location: "query", required: false },
        ],
      })
    );

    expect(html).toContain('name="id"');
    expect(html).not.toContain('name="limit"');
    expect(html.replaceAll("<!-- -->", "")).toContain("2 optional");
    expect(html).toContain("limit, order");
  });

  test("shows the documented example as an example", () => {
    const html = renderToString(
      createElement(EndpointPlayground, {
        method: "GET",
        path: "/messages",
        baseUrl: "https://api.example.com",
        parameters: [],
        exampleResponse: { status: "200", text: '{"id":"example-1"}' },
      })
    );

    expect(html.replaceAll("<!-- -->", "")).toContain("Example of a 200 response.");
    expect(html).toContain("example-1");
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
      location: {
        host: "docs.example.com",
        href: "https://docs.example.com/api/messages",
        origin: "https://docs.example.com",
      },
      sessionStorage,
      localStorage,
    });

    saveSessionAuthToken("https://api.example.com/v1", "secret");

    expect(loadSessionAuthToken("https://api.example.com/v1")).toBe("secret");

    saveSessionAuthToken("https://api.example.com/v1", "");
    expect(loadSessionAuthToken("https://api.example.com/v1")).toBe("");
  });

  // SECURITY REGRESSION GUARDRAIL (SEC-010): a token never fills in for another target host.
  test("keeps a token for one API origin away from an endpoint on another host", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      location: {
        host: "docs.example.com",
        href: "https://docs.example.com/api/messages",
        origin: "https://docs.example.com",
      },
      sessionStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    });

    saveSessionAuthToken("https://api.example.com", "real-key");

    expect(loadSessionAuthToken("https://evil.example")).toBe("");
    expect(loadSessionAuthToken("https://api.example.com/v2")).toBe("real-key");
    expect(loadSessionAuthToken("/api/echo")).toBe("");
  });
});
