import { describe, expect, test } from "vitest";

import {
  REST_REQUEST_CLIENT_IDS,
  buildRestRequestModel,
  buildRestRequestSample,
} from "../src/doxa-agent/rest-request-samples";
import type { RestApiReferenceEndpoint } from "../src/types";

const endpoint: RestApiReferenceEndpoint = {
  id: "create-message",
  title: "Create a message",
  method: "POST",
  path: "/v1/messages",
  description: "Create one message.",
  parameters: [],
  bodyFields: [{ name: "body", type: "string", required: true }],
  bodyContentType: "application/json",
  authRequirement: {
    scheme: "bearer",
    location: "header",
    name: "Authorization",
  },
  sourceEvidence: [],
};

function sample(
  client: (typeof REST_REQUEST_CLIENT_IDS)[number],
  value: RestApiReferenceEndpoint = endpoint,
): string {
  return buildRestRequestSample(
    client,
    buildRestRequestModel(value, "https://api.example.com"),
  ).code;
}

describe("REST request samples", () => {
  test("uses nil and omits the bytes import for a Go request without a body", () => {
    const code = sample("go", { ...endpoint, method: "GET", bodyFields: [] });

    expect(code).toContain('http.NewRequest("GET", url, nil)');
    expect(code).not.toContain('"bytes"');
    expect(code).not.toContain("payload :=");
  });

  test("imports bytes and passes the payload for a Go request with a body", () => {
    const code = sample("go");

    expect(code).toContain('"bytes"');
    expect(code).toContain('payload := []byte(`{"body":"<string>"}`)');
    expect(code).toContain("bytes.NewBuffer(payload)");
  });

  test("uses a quoted Go string when the JSON payload contains a backtick", () => {
    const code = sample("go", {
      ...endpoint,
      bodyFields: [
        {
          name: "body",
          type: "string",
          required: true,
          example: "use `code`",
        },
      ],
    });

    expect(code).toContain(
      'payload := []byte("{\\\"body\\\":\\\"use `code`\\\"}")',
    );
    expect(code).not.toContain('[]byte(`{"body":"use `code`');
  });

  test("escapes a header value that contains single and double quotes", () => {
    const value = `both 'single' and "double"`;
    const withQuotedHeader: RestApiReferenceEndpoint = {
      ...endpoint,
      parameters: [
        {
          name: "X-Quote",
          in: "header",
          type: "string",
          required: true,
          example: value,
        },
      ],
    };

    expect(sample("curl", withQuotedHeader)).toContain(
      `--header 'X-Quote: both '"'"'single'"'"' and "double"'`,
    );
    expect(sample("node-fetch", withQuotedHeader)).toContain(
      `'X-Quote': 'both \\'single\\' and "double"'`,
    );
    expect(sample("node-xhr", withQuotedHeader)).toContain(`require("xhr2")`);
    expect(sample("node-xhr", withQuotedHeader)).toContain(
      `xhr.setRequestHeader('X-Quote', 'both \\'single\\' and "double"');`,
    );
    expect(sample("python-requests", withQuotedHeader)).toContain(
      `"X-Quote": "both 'single' and \\"double\\""`,
    );
    expect(sample("python-httpx", withQuotedHeader)).toContain(
      `"X-Quote": "both 'single' and \\"double\\""`,
    );
    expect(sample("go", withQuotedHeader)).toContain(
      `req.Header.Set("X-Quote", "both 'single' and \\"double\\"")`,
    );
  });

  test("serializes boolean and null examples as Python literals", () => {
    const withPythonValues: RestApiReferenceEndpoint = {
      ...endpoint,
      bodyFields: [
        { name: "enabled", type: "boolean", required: true, example: "true" },
        { name: "disabled", type: "boolean", required: true, example: "false" },
        {
          name: "parentId",
          type: "string | null",
          required: false,
          example: "null",
        },
      ],
    };

    for (const client of ["python-requests", "python-httpx"] as const) {
      expect(sample(client, withPythonValues)).toContain(
        'payload = {"enabled": True, "disabled": False, "parentId": None}',
      );
    }
  });

  test("uses the generic Python request function for an uncommon method", () => {
    const uncommonMethod = { ...endpoint, method: "PROPFIND" };

    expect(sample("python-requests", uncommonMethod)).toContain(
      'requests.request("PROPFIND", url, headers=headers, json=payload)',
    );
    expect(sample("python-httpx", uncommonMethod)).toContain(
      'httpx.request("PROPFIND", url, headers=headers, json=payload)',
    );
  });
});
