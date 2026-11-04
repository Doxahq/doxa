import { beforeEach, describe, expect, test, vi } from "vitest";

import type { DocsContentBinding } from "./binding-runtime-source";
import {
  RENDERER_TIMING_HEADER,
  resetRendererTimingIsolateForTests,
  startRendererTiming,
  type RendererTimingReport,
} from "./renderer-timing";

/** A clock that moves only when a test moves it, like a Worker between I/O. */
function createClock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function readReport(response: Response): RendererTimingReport {
  return JSON.parse(response.headers.get(RENDERER_TIMING_HEADER) ?? "null");
}

beforeEach(() => {
  resetRendererTimingIsolateForTests();
});

describe("renderer timing", () => {
  test("times content calls, phases and the handler", async () => {
    const clock = createClock();
    const timing = startRendererTiming(clock.now);
    const binding: DocsContentBinding = {
      request: vi.fn(async () => {
        clock.advance(40);
        return { ok: true as const, data: {} };
      }),
    };
    const content = timing.wrapContent(binding);

    await timing.measure("routeDataMs", () =>
      content.request({ hostname: "docs.example.com", operation: "getRouteData" })
    );
    await timing.measure("siteConfigMs", async () => {
      await content.request({
        hostname: "docs.example.com",
        operation: "getResolvedSiteConfig",
      });
      clock.advance(5);
    });
    clock.advance(10);
    const response = timing.attach(
      new Response("<html></html>", {
        status: 201,
        headers: { "content-type": "text/html" },
      })
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(await response.text()).toBe("<html></html>");
    expect(readReport(response)).toEqual({
      isolateId: expect.stringMatching(/^[0-9a-f]{8}$/),
      isolateRequests: 1,
      isolateAgeMs: 0,
      requestStartedAt: 1_000,
      routeDataMs: 40,
      siteConfigMs: 45,
      contentCalls: 2,
      contentMs: 80,
      longestContentMs: 40,
      respondedAt: 1_095,
    });
  });

  test("counts the requests that one isolate serves", () => {
    const clock = createClock();
    const first = readReport(
      startRendererTiming(clock.now).attach(new Response(null))
    );
    clock.advance(500);
    const second = readReport(
      startRendererTiming(clock.now).attach(new Response(null))
    );

    expect(second.isolateId).toBe(first.isolateId);
    expect(second.isolateRequests).toBe(2);
    expect(second.isolateAgeMs).toBe(500);
  });

  test("records a failed content call and passes the error on", async () => {
    const clock = createClock();
    const timing = startRendererTiming(clock.now);
    const content = timing.wrapContent({
      request: async () => {
        clock.advance(25);
        throw new Error("runtime unavailable");
      },
    });

    await expect(
      content.request({ hostname: "docs.example.com", operation: "getRouteData" })
    ).rejects.toThrow("runtime unavailable");
    expect(readReport(timing.attach(new Response(null)))).toMatchObject({
      contentCalls: 1,
      contentMs: 25,
    });
  });
});
