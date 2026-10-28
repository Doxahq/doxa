import { describe, expect, test } from "vitest";

import { noPublishedDocsResponse } from "./no-published-docs";

describe("noPublishedDocsResponse", () => {
  test("sends no body to a HEAD request", async () => {
    const response = noPublishedDocsResponse(
      new Request("https://next-auth.doxa.page/", {
        method: "HEAD",
        headers: { accept: "text/html" },
      })
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8"
    );
    expect(await response.text()).toBe("");
  });
});
