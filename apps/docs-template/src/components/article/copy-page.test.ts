import { describe, expect, test } from "vitest";

import { composeMarkdown } from "@/src/components/article/copy-page";

describe("copy page markdown", () => {
  test("includes the REST method in the copied heading", () => {
    expect(
      composeMarkdown(
        {
          title: "Get a user",
          description: "Return one user.",
          body: "Endpoint details.",
        },
        "GET"
      )
    ).toBe("# GET Get a user\n\nReturn one user.\n\nEndpoint details.");
  });
});
