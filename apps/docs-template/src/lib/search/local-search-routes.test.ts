import { DOCS_SEARCH_CONFIG_PATH, MAX_BROWSER_SEARCH_INDEX_BYTES } from "@doxahq/contracts/docs-search";
import { compileSearchArtifact } from "@doxahq/docs-search";
import { describe, expect, test } from "vitest";

import {
  isLocalSearchRequest,
  localSearchResponse,
} from "./local-search-routes";

const compiled = JSON.stringify(
  compileSearchArtifact({
    schemaVersion: 1,
    contentVersion: "local-v1",
    documents: [
      {
        id: "/a",
        slug: "/a",
        title: "Alpha",
        description: "",
        breadcrumb: [],
        section: "default",
        headings: [],
        keywords: [],
        content: "alpha text",
        lines: [{ text: "Alpha line", anchor: "alpha" }],
      },
    ],
  })
);

const source = (value: string | null) => ({
  getCompiledSearchIndex: async () => value,
});
const request = (path: string, init?: RequestInit) =>
  new Request(`http://acme.localhost:3002${path}`, init);

describe("local search routes", () => {
  test("match only the three search paths", () => {
    expect(isLocalSearchRequest(DOCS_SEARCH_CONFIG_PATH)).toBe(true);
    expect(isLocalSearchRequest("/_doxa/search/v1/other")).toBe(false);
    expect(isLocalSearchRequest("/api/search")).toBe(false);
  });

  test("the config selects browser mode for the site's version", async () => {
    const response = await localSearchResponse(
      request(DOCS_SEARCH_CONFIG_PATH),
      source(compiled)
    );
    expect(await response.json()).toEqual({
      mode: "browser",
      contentVersion: "local-v1",
      indexUrl: "/_doxa/search/v1/index?v=local-v1",
      snippetsUrl: "/_doxa/search/v1/snippets?v=local-v1",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("the config falls back to the server without a compiled index", async () => {
    for (const value of [null, "not json", "{}"]) {
      const response = await localSearchResponse(
        request(DOCS_SEARCH_CONFIG_PATH),
        source(value)
      );
      expect(await response.json()).toEqual({ mode: "server" });
    }
  });

  test("the index holds no snippet text, and the snippets file holds it", async () => {
    const index = await localSearchResponse(
      request("/_doxa/search/v1/index?v=local-v1"),
      source(compiled)
    );
    expect(await index.text()).not.toContain('"lines"');

    const snippets = await localSearchResponse(
      request("/_doxa/search/v1/snippets?v=local-v1"),
      source(compiled)
    );
    expect(await snippets.json()).toEqual({
      "/a": [{ text: "Alpha line", anchor: "alpha" }],
    });
  });

  test("answers 409 for another version, like the dispatcher", async () => {
    const response = await localSearchResponse(
      request("/_doxa/search/v1/index?v=older"),
      source(compiled)
    );
    expect(response.status).toBe(409);
  });

  test("answers 404 with no index, 413 above the limit, 405 for writes", async () => {
    const path = "/_doxa/search/v1/index";
    expect((await localSearchResponse(request(path), source(null))).status).toBe(404);

    const large = JSON.stringify({
      serializedIndex: JSON.stringify({
        documentIds: {},
        storedFields: {},
        index: "x".repeat(MAX_BROWSER_SEARCH_INDEX_BYTES + 1),
      }),
    });
    expect((await localSearchResponse(request(path), source(large))).status).toBe(413);

    expect(
      (await localSearchResponse(request(path, { method: "POST" }), source(compiled))).status
    ).toBe(405);
  });
});
