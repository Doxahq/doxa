import { describe, expect, test } from "vitest";

import {
  buildBrowserRequest,
  buildPlaygroundRequest,
  buildTryRequest,
  coerceBodyValue,
  jsonBodyToFieldValues,
  type ApiParameterDefinition,
} from "@/src/lib/api-request";
import {
  buildLiveSample,
  LIVE_SAMPLE_CLIENTS,
  SAMPLE_SECRET,
} from "@/src/lib/api-request-samples";

const body = (name: string, type = "string"): ApiParameterDefinition => ({
  name,
  type,
  location: "body",
  required: false,
});

function bodyText(parameters: ApiParameterDefinition[], values: Record<string, string>) {
  return buildPlaygroundRequest({
    method: "POST",
    path: "/x",
    baseUrl: "https://api.example.com",
    parameters,
    values,
    token: "",
  }).body;
}

describe("the body", () => {
  test.each([
    ["integer", "5", 5],
    ["number", "1.5", 1.5],
    ["int64", "7", 7],
    ["integer", "not a number", "not a number"],
    ["boolean", "true", true],
    ["boolean", "false", false],
    ["boolean", "maybe", "maybe"],
    ["string", "5", "5"],
    ["string", "true", "true"],
    ["object", '{"a":1}', { a: 1 }],
    ["object", "not json", "not json"],
    ["array", "[1,2]", [1, 2]],
    ["string[]", "a, b", ["a", "b"]],
    ["string[]", '["a"]', ["a"]],
  ])("reads a %s from %j", (type, value, expected) => {
    expect(coerceBodyValue(type, value)).toEqual(expected);
  });

  test("sends typed values, not strings", () => {
    expect(
      bodyText([body("count", "integer"), body("pinned", "boolean")], {
        count: "3",
        pinned: "false",
      })?.text
    ).toBe('{"count":3,"pinned":false}');
  });

  test("nests dotted names and list items", () => {
    expect(
      bodyText([body("author.name"), body("author.age", "integer"), body("items[].id"), body("tags[]")], {
        "author.name": "Ada",
        "author.age": "36",
        "items[].id": "a",
        "tags[]": "x",
      })?.text
    ).toBe('{"author":{"name":"Ada","age":36},"items":[{"id":"a"}],"tags":["x"]}');
  });

  // SECURITY REGRESSION GUARDRAIL: page content names the fields.
  test("keeps a field named __proto__ as data", () => {
    const text = bodyText([body("__proto__.polluted")], { "__proto__.polluted": "yes" })?.text;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.parse(text!)).toEqual(
      JSON.parse('{"__proto__":{"polluted":"yes"}}')
    );
  });

  // SECURITY REGRESSION GUARDRAIL: a parsed object must not open a path to
  // `Object.prototype` for a later field.
  test("keeps __proto__ under a parsed object field as data", () => {
    const text = bodyText(
      [
        { name: "settings", type: "object", location: "body", required: true },
        { name: "settings.__proto__.polluted", type: "string", location: "body", required: true },
        { name: "settings.constructor.prototype.polluted2", type: "string", location: "body", required: true },
      ],
      {
        settings: '{"nested":{"__proto__":{"a":1}}}',
        "settings.__proto__.polluted": "yes",
        "settings.constructor.prototype.polluted2": "yes",
      }
    )?.text;

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
    const sent = JSON.parse(text!);
    expect(Object.getOwnPropertyDescriptor(sent.settings, "__proto__")?.value).toEqual({
      polluted: "yes",
    });
    expect(sent.settings.constructor.prototype.polluted2).toBe("yes");
    expect(Object.keys(sent.settings.nested)).toEqual(["__proto__"]);
  });

  test("sends URL-encoded form data", () => {
    const request = buildPlaygroundRequest({
      method: "POST",
      path: "/x",
      baseUrl: "https://api.example.com",
      parameters: [body("name"), body("note")],
      values: { name: "Ada L", note: "a&b" },
      token: "",
      bodyKind: "form",
    });
    expect(request.body).toEqual({
      contentType: "application/x-www-form-urlencoded",
      text: "name=Ada+L&note=a%26b",
    });
    expect(request.headers).toContainEqual([
      "Content-Type",
      "application/x-www-form-urlencoded",
    ]);
  });

  test("sends raw text exactly as typed", () => {
    const request = buildPlaygroundRequest({
      method: "POST",
      path: "/x",
      baseUrl: "https://api.example.com",
      parameters: [],
      values: {},
      token: "",
      rawBody: "not { json",
      bodyKind: "text",
    });
    expect(request.body).toEqual({ contentType: "text/plain", text: "not { json" });
  });

  test("keeps a content type that the reader chose", () => {
    const request = buildPlaygroundRequest({
      method: "POST",
      path: "/x",
      baseUrl: "https://api.example.com",
      parameters: [
        { name: "Content-Type", type: "string", location: "header", required: false },
      ],
      values: { "Content-Type": "application/vnd.api+json" },
      token: "",
      rawBody: "{}",
    });
    expect(
      request.headers.filter(([name]) => name.toLowerCase() === "content-type")
    ).toEqual([["Content-Type", "application/vnd.api+json"]]);
  });

  test.each(["GET", "HEAD"])("sends no body with %s, which fetch refuses", (method) => {
    expect(
      buildPlaygroundRequest({
        method,
        path: "/x",
        baseUrl: "https://api.example.com",
        parameters: [body("a")],
        values: { a: "1" },
        token: "",
      }).body
    ).toBeUndefined();
  });
});

describe("the switch from JSON to fields", () => {
  const parameters = [body("a"), body("author.name"), body("count", "integer")];

  test("fills the known fields", () => {
    expect(
      jsonBodyToFieldValues('{"a":"x","author":{"name":"Ada"},"count":3}', parameters)
    ).toEqual({
      ok: true,
      values: { a: "x", "author.name": "Ada", count: "3" },
    });
  });

  test("treats an empty editor as no values", () => {
    expect(jsonBodyToFieldValues("  ", parameters)).toEqual({ ok: true, values: {} });
  });

  test.each(["{bad", "[1,2]", '"text"', "3"])("refuses %s as a body of fields", (text) => {
    expect(jsonBodyToFieldValues(text, parameters)).toEqual({
      ok: false,
      reason: "invalid_json",
    });
  });

  test("refuses to drop a field that the form does not show", () => {
    expect(jsonBodyToFieldValues('{"a":"x","secret":"y"}', parameters)).toEqual({
      ok: false,
      reason: "unknown_fields",
    });
  });

  test("refuses to drop the other items of a list", () => {
    expect(
      jsonBodyToFieldValues('{"items":[{"id":1},{"id":2}]}', [body("items[].id")])
    ).toEqual({ ok: false, reason: "unknown_fields" });
  });
});

describe("the key", () => {
  const auth = (name: string, type: string, location: ApiParameterDefinition["location"]) => ({
    name,
    type,
    location,
    required: true,
  });
  const request = (parameter: ApiParameterDefinition, token = "secret") =>
    buildPlaygroundRequest({
      method: "GET",
      path: "/x",
      baseUrl: "https://api.example.com",
      parameters: [parameter],
      values: {},
      token,
    });

  test("uses the documented header", () => {
    expect(request(auth("X-Key", "apiKey", "header")).headers).toEqual([["X-Key", "secret"]]);
  });

  test("sends a bearer token with its prefix", () => {
    expect(request(auth("Authorization", "bearer", "header")).headers).toEqual([
      ["Authorization", "Bearer secret"],
    ]);
  });

  // A published page can name the header "API key", which `Headers` refuses.
  test("replaces a label that is not a header name", () => {
    expect(request(auth("API key", "apiKey", "header")).headers).toEqual([
      ["X-API-Key", "secret"],
    ]);
    const built = buildBrowserRequest({
      method: "GET",
      path: "/x",
      baseUrl: "https://api.example.com",
      parameters: [auth("API key", "apiKey", "header")],
      values: {},
      token: "secret",
    });
    expect(new Headers(built.init.headers).get("X-API-Key")).toBe("secret");
  });

  test("replaces a label that is not a query name", () => {
    expect(request(auth("API key", "apiKey", "query")).query).toEqual([["api_key", "secret"]]);
  });

  test("encodes user:password for basic auth", () => {
    expect(request(auth("Authorization", "basic", "header"), "ada:pä").headers).toEqual([
      ["Authorization", `Basic ${Buffer.from("ada:pä").toString("base64")}`],
    ]);
  });

  test("keeps a basic value that is already encoded", () => {
    expect(request(auth("Authorization", "basic", "header"), "YWRhOnB3").headers).toEqual([
      ["Authorization", "Basic YWRhOnB3"],
    ]);
  });

  test("sends a cookie key through the proxy, and refuses it in the browser", () => {
    const parameter = auth("session", "apiKey", "cookie");
    expect(request(parameter).cookies).toEqual([["session", "secret"]]);
    expect(() =>
      buildBrowserRequest({
        method: "GET",
        path: "/x",
        baseUrl: "https://api.example.com",
        parameters: [parameter],
        values: {},
        token: "secret",
      })
    ).toThrow(/Cookie authentication/);
  });
});

describe("the browser request", () => {
  // SECURITY REGRESSION GUARDRAIL: a redirect must not carry a key to another host.
  test("never follows a redirect and sends no docs cookies", () => {
    const { init } = buildBrowserRequest({
      method: "GET",
      path: "/x",
      baseUrl: "https://api.example.com",
      parameters: [],
      values: {},
      token: "",
    });
    expect(init.redirect).toBe("manual");
    expect(init.credentials).toBe("omit");
  });
});

describe("the proxy request", () => {
  // SECURITY REGRESSION GUARDRAIL (SEC-010): the request cannot name a target.
  test("holds no URL and no host, whatever the base URL is", () => {
    const request = buildTryRequest({
      method: "POST",
      path: "\\evil.example/collect",
      baseUrl: "https://api.example.com/v1",
      parameters: [
        { name: "q", type: "string", location: "query", required: false },
        { name: "X-Key", type: "apiKey", location: "header", required: true },
      ],
      values: { q: "a" },
      token: "secret",
      rawBody: "{}",
    }, "target-1");

    expect(Object.keys(request).sort()).toEqual([
      "body",
      "cookies",
      "headers",
      "method",
      "path",
      "query",
      "targetId",
      "v",
    ]);
    expect(JSON.stringify(request)).not.toContain("api.example.com");
    expect(request.path).toBe("/evil.example/collect");
  });
});

describe("the live sample", () => {
  const input = {
    method: "POST",
    path: "/notes/{id}",
    baseUrl: "https://api.example.com/v1",
    parameters: [
      { name: "id", type: "string", location: "path", required: true },
      { name: "Authorization", type: "bearer", location: "header", required: true },
      { name: "limit", type: "integer", location: "query", required: false },
      { name: "title", type: "string", location: "body", required: true },
    ] satisfies ApiParameterDefinition[],
    values: { id: "abc", limit: "5", title: "it's here" },
  };

  test("draws cURL with the key as a shell variable", () => {
    expect(buildLiveSample("curl", input)).toBe(
      [
        "curl --request POST \\",
        "  --url 'https://api.example.com/v1/notes/abc?limit=5' \\",
        '  --header "Authorization: Bearer $API_KEY" \\',
        "  --header 'Content-Type: application/json' \\",
        `  --data '{"title":"it'\\''s here"}'`,
      ].join("\n")
    );
  });

  test("draws JavaScript that reads the key from the environment", () => {
    const sample = buildLiveSample("node-fetch", input);
    expect(sample).toContain('"Authorization": "Bearer " + process.env.API_KEY,');
    expect(sample).toContain('fetch("https://api.example.com/v1/notes/abc?limit=5"');
    expect(sample).not.toContain(SAMPLE_SECRET);
  });

  test("draws Python that reads the key from the environment", () => {
    const sample = buildLiveSample("python-requests", input);
    expect(sample).toContain("import os");
    expect(sample).toContain('"Authorization": "Bearer " + os.environ["API_KEY"],');
    expect(sample).not.toContain(SAMPLE_SECRET);
  });

  test("draws XMLHttpRequest that reads the key from the environment", () => {
    const sample = buildLiveSample("node-xhr", input);
    expect(sample.split("\n")[0]).toBe('const XMLHttpRequest = require("xhr2");');
    expect(sample).toContain('xhr.open("POST", "https://api.example.com/v1/notes/abc?limit=5");');
    expect(sample).toContain('xhr.setRequestHeader("Authorization", "Bearer " + process.env.API_KEY);');
    expect(sample).toContain(`xhr.send(${JSON.stringify('{"title":"it\'s here"}')});`);
    expect(sample).not.toContain(SAMPLE_SECRET);
  });

  test("draws httpx with its own name for the raw body", () => {
    const sample = buildLiveSample("python-httpx", input);
    expect(sample).toContain("import httpx");
    expect(sample).toContain("response = httpx.request(");
    expect(sample).toContain("content=");
    expect(sample).not.toContain("data=");
    expect(sample).not.toContain(SAMPLE_SECRET);
  });

  test("draws Go that reads the key from the environment", () => {
    const sample = buildLiveSample("go", input);
    expect(sample).toContain('req.Header.Set("Authorization", "Bearer " + os.Getenv("API_KEY"))');
    expect(sample).toContain('\t"os"');
    expect(sample).toContain('\t"strings"');
    expect(sample).toContain('http.NewRequest("POST", "https://api.example.com/v1/notes/abc?limit=5", strings.NewReader(');
    expect(sample).not.toContain(SAMPLE_SECRET);
  });

  test("holds no half of a surrogate pair, which Go refuses", () => {
    const sample = buildLiveSample("go", {
      ...input,
      parameters: [
        { name: "X-Trace", type: "string", location: "header", required: true },
        { name: "note", type: "string", location: "body", required: true },
      ],
      values: { "X-Trace": "a\uD800b", note: "c\uDC00d \u{1F600}" },
    });

    expect(sample).not.toMatch(/\\ud[89ab]/i);
    expect(sample).toContain('"a\uFFFDb"');
    expect(sample).toContain("\u{1F600}");
  });

  test("imports in Go only what the sample uses", () => {
    const sample = buildLiveSample("go", { ...input, method: "GET", parameters: [], values: {} });
    expect(sample).not.toContain('"os"');
    expect(sample).not.toContain('"strings"');
    expect(sample).toContain(", nil)");
  });

  test("names a key in the query without encoding the placeholder", () => {
    const sample = buildLiveSample("curl", {
      ...input,
      parameters: [{ name: "key", type: "apiKey", location: "query", required: true }],
      values: {},
    });
    expect(sample).toContain('--url "https://api.example.com/v1/notes/{id}?key=$API_KEY"'.replace("{id}", "%7Bid%7D"));
  });

  // SECURITY REGRESSION GUARDRAIL: page content names parameters, and readers paste samples.
  test("keeps a hostile parameter name from running in a shell", () => {
    const sample = buildLiveSample("curl", {
      method: "GET",
      path: "/x",
      baseUrl: "https://api.example.com",
      parameters: [
        { name: "x$(touch pwned)", type: "bearer", location: "header", required: true },
        { name: "a'; touch pwned; '", type: "string", location: "header", required: false },
      ],
      values: { "a'; touch pwned; '": "b" },
    });
    expect(sample).toContain(`'a'\\''; touch pwned; '\\'': b'`);
    expect(sample).not.toMatch(/"[^"]*\$\(touch pwned\)[^"]*"/);
  });

  test("has no way to hold the real key", () => {
    expect(Object.keys(input)).not.toContain("token");
    for (const { client } of LIVE_SAMPLE_CLIENTS) {
      expect(buildLiveSample(client, input)).not.toContain("secret");
    }
  });
});
