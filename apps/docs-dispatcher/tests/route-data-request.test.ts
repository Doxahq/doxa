import { describe, expect, test } from "vitest";

import { parseRouteDataRequest } from "../src/route-data-request";

describe("route-data request parsing", () => {
  test("accepts one normalized path and an optional render hint", () => {
    const result = parseRouteDataRequest(
      new Request(
        `https://docs.example.com/_doxa/route-data/v1?path=%2Fguide&render=${"a".repeat(64)}`,
        { headers: { origin: "https://docs.example.com" } },
      ),
    );

    expect(result).toEqual({
      status: "ok",
      pathname: "/guide",
      renderHint: "a".repeat(64),
      sharedCacheEligible: true,
    });
  });

  test.each([
    "?path=%2Fguide&path=%2Fother",
    "?path=%2Fguide&unknown=1",
    "?path=https%3A%2F%2Fevil.example",
    "?path=%2F..%2Fsecret",
    "?path=%2Fguide%255Csecret",
    "?path=%2Fguide%252Fsecret",
    "?path=%2F_doxa%2Fprivate",
  ])("rejects an ambiguous or internal input: %s", (search) => {
    expect(() =>
      parseRouteDataRequest(
        new Request(`https://docs.example.com/_doxa/route-data/v1${search}`),
      ),
    ).toThrow();
  });

  test("rejects cross-origin browser use", () => {
    expect(() =>
      parseRouteDataRequest(
        new Request(
          "https://docs.example.com/_doxa/route-data/v1?path=%2Fguide",
          {
            headers: {
              origin: "https://evil.example",
              "sec-fetch-site": "cross-site",
            },
          },
        ),
      ),
    ).toThrow(/same-origin/i);
  });

  test("marks cookie or authorization requests as shared-cache ineligible", () => {
    const result = parseRouteDataRequest(
      new Request(
        "https://docs.example.com/_doxa/route-data/v1?path=%2Fguide",
        {
          headers: { cookie: "session=private" },
        },
      ),
    );
    expect(result.status === "ok" && result.sharedCacheEligible).toBe(false);
  });
});
