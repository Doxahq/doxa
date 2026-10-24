import { describe, expect, test, vi } from "vitest";

import {
  createServerTiming,
  mergeFreshInternalServerTiming,
} from "../src/server-timing";

describe("server timing", () => {
  test("records measurements only when DEBUG is explicitly true", async () => {
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(25);
    const timing = createServerTiming(" true ", now);

    const value = await timing.measure(
      "doxa_resolve",
      async () => "resolved",
      "MISS",
    );

    expect(value).toBe("resolved");
    expect(timing.headerValue()).toBe('doxa_resolve;dur=15;desc="MISS"');
  });

  test.each([undefined, "", "false", "1", "yes"])(
    "keeps measurements disabled for DEBUG=%s",
    async (debug) => {
      const now = vi.fn<() => number>();
      const timing = createServerTiming(debug, now);

      await expect(timing.measure("doxa_total", async () => 42)).resolves.toBe(
        42,
      );

      expect(timing.enabled).toBe(false);
      expect(timing.entries()).toEqual([]);
      expect(timing.headerValue()).toBeNull();
      expect(now).not.toHaveBeenCalled();
    },
  );

  test("reads a description after the measured operation finishes", async () => {
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(15);
    let cacheStatus = "UNKNOWN";
    const timing = createServerTiming("true", now);

    await timing.measure(
      "doxa_html",
      async () => {
        cacheStatus = "MISS";
      },
      () => cacheStatus,
    );

    expect(timing.headerValue()).toBe('doxa_html;dur=5;desc="MISS"');
  });

  test.each([
    ["MISS", true],
    ["BYPASS", true],
    ["EXPIRED", true],
    ["REVALIDATED", true],
    ["HIT", false],
    ["STALE", false],
    ["UPDATING", false],
  ] as const)(
    "merges private timings for a %s cache response only when they are fresh",
    (cacheStatus, expectedFresh) => {
      const timing = createServerTiming("true");
      const response = new Response(null, {
        headers: {
          "x-doxa-internal-server-timing":
            'doxa_prerender_manifest_get;dur=12;desc="HIT"',
        },
      });

      mergeFreshInternalServerTiming(timing, response, cacheStatus);

      expect(timing.entries()).toHaveLength(expectedFresh ? 1 : 0);
    },
  );
});
