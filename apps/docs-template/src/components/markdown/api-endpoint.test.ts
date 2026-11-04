import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import { EndpointChromeContext } from "@/src/components/api-reference/endpoint-context";
import {
  ApiEndpoint,
  ApiParam,
  ApiParams,
  ApiRequestExample,
  buildBrowserRequest,
  collectApiParameterDefinitions,
} from "@/src/components/markdown/api-endpoint";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("interactive API endpoint", () => {
  test("renders the endpoint bar and its parameter groups on the server", () => {
    const children = [
      createElement(
        ApiParams,
        { title: "Authorizations", key: "auth" },
        createElement(
          ApiParam,
          {
            name: "Authorization",
            type: "bearer",
            location: "header",
            required: true,
          },
          "Bearer access token."
        )
      ),
      createElement(
        ApiParams,
        { title: "Path Parameters", key: "path" },
        createElement(
          ApiParam,
          { name: "userId", type: "string", location: "path", required: true },
          "The user identifier."
        )
      ),
    ];
    const html = renderToString(
      createElement(
        ApiEndpoint,
        {
          method: "GET",
          path: "/users/{userId}",
          baseUrl: "https://api.example.com/v1",
        },
        children
      )
    );

    // The path renders as segments so a path parameter can be marked, so the
    // assertions look for the parts rather than the joined string.
    expect(html).toContain('aria-label="GET method"');
    expect(html).toContain("users");
    expect(html).toContain("{userId}");
    expect(html).toContain("Authorizations");
    expect(html).toContain("Path Parameters");
    expect(html).toContain("The user identifier.");
    expect(html).not.toContain("Bearer secret");
  });

  test("renders children only when the reference layout owns the chrome", () => {
    const endpoint = createElement(
      ApiEndpoint,
      { method: "GET", path: "/users/{userId}", baseUrl: "https://api.test" },
      createElement(
        ApiParams,
        { title: "Path Parameters" },
        createElement(
          ApiParam,
          { name: "userId", type: "string", location: "path", required: true },
          "The user identifier."
        )
      )
    );
    const html = renderToString(
      createElement(EndpointChromeContext.Provider, { value: true }, endpoint)
    );

    expect(html).toContain("Path Parameters");
    expect(html).not.toContain('aria-label="GET method"');
  });

  test("renders only the first request client outside the reference layout", () => {
    const html = renderToString(
      createElement(
        ApiEndpoint,
        { method: "GET", path: "/health" },
        createElement(
          ApiRequestExample,
          { client: "curl", lang: "bash", label: "Health" },
          "curl /health"
        ),
        createElement(
          ApiRequestExample,
          { client: "go", lang: "go", label: "Health" },
          "http.Get(url)"
        )
      )
    );

    expect(html).toContain("curl /health");
    expect(html).not.toContain("http.Get(url)");
  });

  test("discovers scalar parameter definitions from child elements", () => {
    const children = createElement(
      ApiParams,
      { title: "Query Parameters" },
      createElement(
        ApiParam,
        {
          name: "include",
          type: "string",
          location: "query",
          required: false,
        },
        "Optional related data."
      )
    );

    expect(collectApiParameterDefinitions(children)).toEqual([
      {
        name: "include",
        type: "string",
        location: "query",
        required: false,
      },
    ]);
  });

  test("builds path, query, header, and JSON body inputs in the browser", () => {
    const request = buildBrowserRequest({
      method: "POST",
      path: "/users/{userId}",
      baseUrl: "https://api.example.com/v1/",
      parameters: [
        { name: "userId", type: "string", location: "path", required: true },
        { name: "include", type: "string", location: "query", required: false },
        {
          name: "X-Request-ID",
          type: "string",
          location: "header",
          required: false,
        },
        {
          name: "displayName",
          type: "string",
          location: "body",
          required: true,
        },
      ],
      values: {
        userId: "user/123",
        include: "teams",
        "X-Request-ID": "request-1",
        displayName: "Ada",
      },
      token: "",
    });

    expect(request.url).toBe(
      "https://api.example.com/v1/users/user%2F123?include=teams"
    );
    expect(request.init.method).toBe("POST");
    expect(new Headers(request.init.headers).get("X-Request-ID")).toBe(
      "request-1"
    );
    expect(new Headers(request.init.headers).get("Content-Type")).toBe(
      "application/json"
    );
    expect(request.init.body).toBe('{"displayName":"Ada"}');
  });

  test("resolves a relative API base URL against the docs origin", () => {
    vi.stubGlobal("window", {
      location: { origin: "https://docs.example.com" },
    });

    const request = buildBrowserRequest({
      method: "GET",
      path: "/v1/messages/message-1",
      baseUrl: "/api/echo",
      parameters: [],
      values: {},
      token: "",
    });

    expect(request.url).toBe(
      "https://docs.example.com/api/echo/v1/messages/message-1"
    );
  });

  test.each([
    ["/", "\\evil.example/collect"],
    ["/", "/\\evil.example/collect"],
    ["/", "\\\\evil.example/collect"],
    ["", "\\evil.example/collect"],
    ["/api", "../\\evil.example"],
  ])(
    "keeps a path that names a host on the docs origin (base %j, path %j)",
    (baseUrl, path) => {
      vi.stubGlobal("window", {
        location: { origin: "https://docs.example.com" },
      });

      const request = buildBrowserRequest({
        method: "GET",
        path,
        baseUrl,
        parameters: [
          { name: "key", type: "apikey", location: "query", required: true },
        ],
        values: {},
        token: "FAKE_CANARY",
      });

      expect(new URL(request.url).origin).toBe("https://docs.example.com");
    }
  );

  test("refuses a path that the browser still reads as another host", () => {
    vi.stubGlobal("window", {
      location: { origin: "https://docs.example.com" },
    });

    // The browser drops the tab, which leaves `/\evil.example/collect`.
    expect(() =>
      buildBrowserRequest({
        method: "GET",
        path: "\t\\evil.example/collect",
        baseUrl: "/",
        parameters: [
          { name: "key", type: "apikey", location: "query", required: true },
        ],
        values: {},
        token: "FAKE_CANARY",
      })
    ).toThrow(/another host/);
  });

  test.each([
    ["/", "/v1/users", "https://docs.example.com/v1/users"],
    ["/", "v1/users", "https://docs.example.com/v1/users"],
    ["/api/", "//v1/users", "https://docs.example.com/api/v1/users"],
    ["https://api.example.com/v2", "\\users", "https://api.example.com/v2/users"],
  ])(
    "keeps the request on the base origin (base %j, path %j)",
    (baseUrl, path, expected) => {
      vi.stubGlobal("window", {
        location: { origin: "https://docs.example.com" },
      });

      const request = buildBrowserRequest({
        method: "GET",
        path,
        baseUrl,
        parameters: [],
        values: {},
        token: "",
      });

      expect(request.url).toBe(expected);
    }
  );

  test("places reader-supplied authorization in its declared location", () => {
    const headerRequest = buildBrowserRequest({
      method: "GET",
      path: "/users",
      baseUrl: "https://api.example.com",
      parameters: [
        {
          name: "Authorization",
          type: "bearer",
          location: "header",
          required: true,
        },
      ],
      values: {},
      token: "secret",
    });
    const queryRequest = buildBrowserRequest({
      method: "GET",
      path: "/users",
      baseUrl: "https://api.example.com",
      parameters: [
        { name: "api_key", type: "apiKey", location: "query", required: true },
      ],
      values: {},
      token: "secret",
    });

    expect(new Headers(headerRequest.init.headers).get("Authorization")).toBe(
      "Bearer secret"
    );
    expect(queryRequest.url).toBe(
      "https://api.example.com/users?api_key=secret"
    );
  });

  test("rejects cookie inputs that browser fetch cannot set", () => {
    expect(() =>
      buildBrowserRequest({
        method: "GET",
        path: "/users",
        baseUrl: "https://api.example.com",
        parameters: [
          {
            name: "session",
            type: "apiKey",
            location: "cookie",
            required: true,
          },
        ],
        values: {},
        token: "secret",
      })
    ).toThrow(/cookie authentication cannot be set/i);
  });
});
