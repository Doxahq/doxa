import type { DocsHostResolution } from "@doxahq/contracts";
import { describe, expect, test, vi } from "vitest";

import {
  createRuntimeTrace,
  requestDocsRuntime,
  splitRuntimeTiming,
} from "../src/runtime-trace";
import type { RuntimeResponse } from "../src/worker-exports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const resolution: DocsHostResolution = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "version-1",
  artifactPrefix: "sites/site-1/versions/v1",
  manifestPath: "sites/site-1/versions/v1/manifest.json",
  accessPolicy: "public",
};
const timing = {
  manifestMs: 1,
  operationMs: 2,
  totalMs: 3,
  reads: 0,
  r2Reads: 0,
  readMs: 0,
  versionColdInIsolate: false,
  isolate: { id: "isolate-1", requests: 1, ageMs: 0 },
};

describe("createRuntimeTrace", () => {
  test("makes a new random UUID per call", () => {
    const first = createRuntimeTrace("content");
    const second = createRuntimeTrace("content");

    expect(first.id).toMatch(UUID);
    expect(second.id).not.toBe(first.id);
    expect(first.caller).toBe("content");
  });
});

describe("splitRuntimeTiming", () => {
  test("keeps an answer without timing as it is", () => {
    const answer: RuntimeResponse = { ok: true, data: { a: 1 } };
    expect(splitRuntimeTiming(answer)).toEqual({
      response: answer,
      timing: undefined,
    });
  });

  test("removes the timing from a success and from an error", () => {
    expect(
      splitRuntimeTiming({ ok: true, data: { a: 1 }, timing }),
    ).toEqual({ response: { ok: true, data: { a: 1 } }, timing });
    const failed = splitRuntimeTiming({
      ok: false,
      error: { code: "version_not_found", message: "gone" },
      timing: { bad: true },
    });
    expect(failed).toEqual({
      response: {
        ok: false,
        error: { code: "version_not_found", message: "gone" },
      },
      timing: undefined,
    });
  });
});

describe("requestDocsRuntime", () => {
  test("sends a dispatcher trace and returns the answer without timing", async () => {
    const runtime = {
      request: vi.fn(async (): Promise<RuntimeResponse> => ({
        ok: true,
        data: "plan",
        timing,
      })),
    };

    const answer = await requestDocsRuntime(
      runtime,
      { resolution, operation: "getPage", payload: undefined },
      "content",
    );

    expect(answer).toEqual({ ok: true, data: "plan" });
    expect(runtime.request).toHaveBeenCalledWith({
      resolution,
      operation: "getPage",
      trace: { id: expect.stringMatching(UUID), caller: "content" },
    });
  });
});
