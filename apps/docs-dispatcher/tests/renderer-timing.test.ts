import { describe, expect, test, vi } from "vitest";

import {
  observeResponseBody,
  parseRendererTimingReport,
  takeRendererTiming,
  toRenderPhases,
  type RendererTimingReport,
} from "../src/renderer-timing";

const REPORT: RendererTimingReport = {
  isolateId: "a1b2c3d4",
  isolateRequests: 2,
  isolateAgeMs: 900,
  requestStartedAt: 10_300,
  routeDataMs: 150,
  contentCalls: 2,
  contentMs: 180,
  longestContentMs: 150,
  respondedAt: 10_500,
};

describe("renderer timing report", () => {
  test("removes the header and parses the report", () => {
    const { response, report } = takeRendererTiming(
      new Response("page", {
        status: 404,
        headers: {
          "content-type": "text/html",
          "x-doxa-renderer-timing": JSON.stringify(REPORT),
        },
      }),
    );
    expect(report).toEqual(REPORT);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(response.headers.has("x-doxa-renderer-timing")).toBe(false);
  });

  test("leaves a response without the header unchanged", () => {
    const original = new Response("page");
    expect(takeRendererTiming(original)).toEqual({
      response: original,
      report: undefined,
    });
  });

  test.each([
    "not json",
    "null",
    JSON.stringify({ ...REPORT, isolateId: 7 }),
    JSON.stringify({ ...REPORT, contentMs: "180" }),
    JSON.stringify({ ...REPORT, routeDataMs: null }),
  ])("ignores a malformed report: %s", (raw) => {
    expect(parseRendererTimingReport(raw)).toBeUndefined();
  });

  test("splits a call into the time before, inside and after the handler", () => {
    expect(
      toRenderPhases({ report: REPORT, calledAt: 10_000, respondedAt: 10_900 }),
    ).toEqual({
      beforeHandlerMs: 300,
      handlerMs: 200,
      afterHandlerMs: 400,
      routeDataMs: 150,
      contentCalls: 2,
      contentMs: 180,
      longestContentMs: 150,
    });
  });
});

describe("observeResponseBody", () => {
  test("passes the body through and reports its size at the end", async () => {
    const onComplete = vi.fn();
    const response = observeResponseBody(
      new Response("<html>docs</html>", { status: 201 }),
      onComplete,
    );
    expect(onComplete).not.toHaveBeenCalled();
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("<html>docs</html>");
    expect(onComplete).toHaveBeenCalledWith({
      bodyMs: expect.any(Number),
      bytes: 17,
    });
  });

  test("reports at once for a response without a body", () => {
    const onComplete = vi.fn();
    observeResponseBody(new Response(null, { status: 304 }), onComplete);
    expect(onComplete).toHaveBeenCalledWith({ bodyMs: 0, bytes: 0 });
  });
});
