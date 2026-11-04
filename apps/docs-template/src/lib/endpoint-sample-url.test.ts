import type { RuntimeMdxElementNode } from "@doxahq/mdx-runtime";
import { describe, expect, test } from "vitest";

import { nodeText, type EndpointCodeSample } from "@/src/lib/endpoint-document";
import { readApiBaseUrl, withApiBaseUrl } from "@/src/lib/endpoint-sample-url";

/** A sample with each string as its own highlighted token. */
function sampleOf(...tokens: string[]): EndpointCodeSample {
  const node: RuntimeMdxElementNode = {
    type: "element",
    name: "pre",
    children: tokens.map((value) => ({
      type: "element" as const,
      name: "span",
      children: [{ type: "text" as const, value }],
    })),
  } as RuntimeMdxElementNode;
  return { client: "curl", label: "Request", text: tokens.join(""), node };
}

const OWNER = "https://api.acme.com";

describe("readApiBaseUrl", () => {
  test("gives an absolute URL without the last slash", () => {
    expect(readApiBaseUrl("https://api.acme.com/v1/")).toBe("https://api.acme.com/v1");
  });

  test.each([
    undefined,
    "",
    "/api/echo",
    "ftp://api.acme.com",
    // SECURITY REGRESSION GUARDRAIL: readers paste samples into a shell.
    "https://api.acme.com/';touch pwned;'",
    'https://api.acme.com/"$(touch pwned)"',
    "https://api.acme.com/ x",
  ])("gives nothing for %s", (value) => {
    expect(readApiBaseUrl(value)).toBeNull();
  });
});

describe("withApiBaseUrl", () => {
  test("puts the owner's host in place of the generated one, in the page and the copy", () => {
    const out = withApiBaseUrl(
      sampleOf("await fetch(", "'http://localhost:4000/v1/projects'", ", {});"),
      "/v1/projects",
      OWNER,
    );
    expect(nodeText(out.node)).toBe("await fetch('https://api.acme.com/v1/projects', {});");
    expect(out.text).toBe(nodeText(out.node));
  });

  test("handles a URL that highlighting split over tokens", () => {
    const out = withApiBaseUrl(
      sampleOf("curl '", "http:", "//local", "host:4000", "/v1/pro", "jects", "'"),
      "/v1/projects",
      OWNER,
    );
    expect(nodeText(out.node)).toBe("curl 'https://api.acme.com/v1/projects'");
  });

  test("replaces a base path of the generated URL too", () => {
    const out = withApiBaseUrl(sampleOf('"https://old.example.com/v2/notes"'), "/notes", OWNER);
    expect(nodeText(out.node)).toBe('"https://api.acme.com/notes"');
  });

  test("keeps the query", () => {
    const out = withApiBaseUrl(sampleOf("'http://localhost/notes?limit=5'"), "/notes", OWNER);
    expect(nodeText(out.node)).toBe("'https://api.acme.com/notes?limit=5'");
  });

  test("matches a filled path parameter", () => {
    const out = withApiBaseUrl(sampleOf("'http://localhost/notes/abc'"), "/notes/{id}", OWNER);
    expect(nodeText(out.node)).toBe("'https://api.acme.com/notes/abc'");
  });

  test("keeps a path parameter that is not filled", () => {
    const out = withApiBaseUrl(sampleOf("'http://localhost/notes/{id}'"), "/notes/{id}", OWNER);
    expect(nodeText(out.node)).toBe("'https://api.acme.com/notes/{id}'");
  });

  test("changes only the request URL, not a URL in the body", () => {
    const out = withApiBaseUrl(
      sampleOf("'http://localhost/hooks' --data '{\"url\":\"http://mine.example/hooks\"}'"),
      "/hooks",
      OWNER,
    );
    expect(nodeText(out.node)).toContain("https://api.acme.com/hooks");
    expect(nodeText(out.node)).toContain("http://mine.example/hooks");
  });

  test("handles a trailing slash on the request URL", () => {
    const out = withApiBaseUrl(
      sampleOf(`curl 'https://old.example.com/notes/' --data '{"callback":"https://hooks.example.com/notes"}'`),
      "/notes",
      OWNER,
    );
    expect(nodeText(out.node)).toBe(
      `curl 'https://api.acme.com/notes/' --data '{"callback":"https://hooks.example.com/notes"}'`,
    );
  });

  test("leaves the sample as it is when the first URL is not the request URL", () => {
    const sample = sampleOf(`curl 'https://old.example.com/other' --data '{"to":"https://x.example.com/notes"}'`);
    expect(withApiBaseUrl(sample, "/notes", OWNER)).toBe(sample);
  });

  test("handles a base URL with no path for the page path /", () => {
    const out = withApiBaseUrl(sampleOf("'http://localhost:4000'"), "/", OWNER);
    expect(nodeText(out.node)).toBe("'https://api.acme.com'");
  });

  test("keeps the query of a URL with no path", () => {
    const out = withApiBaseUrl(sampleOf("'https://old.example.com?limit=5'"), "/", OWNER);
    expect(nodeText(out.node)).toBe("'https://api.acme.com?limit=5'");
  });

  test("does not read a slash in the query as the path", () => {
    const sample = sampleOf("'https://old.example.com?next=/notes'");
    expect(withApiBaseUrl(sample, "/notes", OWNER)).toBe(sample);
  });

  test("matches a segment that mixes text and parameters", () => {
    const out = withApiBaseUrl(sampleOf("'http://localhost/files/report.v2.json'"), "/files/{name}.v{major}.json", OWNER);
    expect(nodeText(out.node)).toBe("'https://api.acme.com/files/report.v2.json'");
  });

  test("does not match a segment whose text overlaps", () => {
    const sample = sampleOf("'http://localhost/ab'");
    expect(withApiBaseUrl(sample, "/ab{x}ab", OWNER)).toBe(sample);
  });

  // SECURITY REGRESSION GUARDRAIL: page content names the path, and this runs
  // while the shared renderer draws the page.
  test("stays fast for a hostile path", () => {
    const parameters = Array.from({ length: 2_000 }, (_, index) => `{p${index}}`).join("");
    const sample = sampleOf(`curl 'https://old.example.com/${"a".repeat(100_000)}'`);
    const startedAt = performance.now();

    expect(withApiBaseUrl(sample, `/${parameters}Z`, OWNER)).toBe(sample);
    expect(performance.now() - startedAt).toBeLessThan(200);
  });

  test("does not take a longer path as this path", () => {
    const sample = sampleOf("'http://localhost/notes/archive'");
    expect(withApiBaseUrl(sample, "/notes", OWNER)).toBe(sample);
  });

  test("does not change the shared page content", () => {
    const sample = sampleOf("'http://localhost/notes'");
    withApiBaseUrl(sample, "/notes", OWNER);
    expect(nodeText(sample.node)).toBe("'http://localhost/notes'");
  });

  test("keeps the sample when the site has no base URL", () => {
    const sample = sampleOf("'http://localhost/notes'");
    expect(withApiBaseUrl(sample, "/notes", null)).toBe(sample);
  });
});
