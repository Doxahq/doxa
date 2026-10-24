import { describe, expect, test } from "vitest";

import { formatApiTitle } from "@/src/lib/api-reference";

describe("API reference text titles", () => {
  test("prefixes a valid HTTP method for plain-text surfaces", () => {
    expect(formatApiTitle("Get a user", "GET")).toBe("GET Get a user");
  });

  test("does not change a title without a supported HTTP method", () => {
    expect(formatApiTitle("Get a user", undefined)).toBe("Get a user");
    expect(formatApiTitle("Get a user", "FETCH")).toBe("Get a user");
  });

  test("does not duplicate a method already present in legacy content", () => {
    expect(formatApiTitle("GET /users/{id}", "GET")).toBe("GET /users/{id}");
  });
});
