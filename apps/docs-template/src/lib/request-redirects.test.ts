import { describe, expect, test } from "vitest";

import { getRedirectDecision } from "./request-redirects";

describe("request redirects", () => {
  test("delegates the root path to runtime navigation", () => {
    expect(getRedirectDecision("/")).toBeNull();
  });

  test("routes the legacy docs path through the dynamic root", () => {
    expect(getRedirectDecision("/docs")).toEqual({
      redirectPath: "/",
      status: 307,
    });
  });
});
