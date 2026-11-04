import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { listFrozenArtifactSets } from "@doxahq/docs-artifact-fixtures";
import { readDocsRuntimeCallTiming } from "@doxahq/contracts/docs-runtime-trace";

import {
  resetRuntimeSourceCachesForTests,
  runResolvedRuntimeRequest,
  type RuntimeSourceEnv,
} from "../src/runtime-source";
import {
  markVersionSeen,
  recordIsolateRequest,
  resetRuntimeTraceStateForTests,
} from "../src/runtime-trace";
import { createTreeBucket } from "./support/tree-bucket";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

const TRACE = {
  id: "0b6f9f5e-2a4c-4d8e-9b1a-6c3d2e1f0a9b",
  caller: "prefetch",
} as const;

beforeEach(() => {
  resetRuntimeSourceCachesForTests();
  resetRuntimeTraceStateForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function showcaseSet() {
  const set = listFrozenArtifactSets().find(
    (item) => item.name === "component-showcase",
  );
  if (!set) throw new Error("The component-showcase fixture is missing.");
  return set;
}

function createEnv(objects: Record<string, string>): RuntimeSourceEnv {
  return {
    DOCS_BUCKET: createTreeBucket(objects).bucket,
    DOCS_CONTENT_TOKEN: "test-runtime-token",
    DOCS_PUBLIC_BASE_URL: "https://frozen.doxa.page",
  };
}

function readsLines(spy: ReturnType<typeof vi.spyOn>): unknown[] {
  return spy.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes("docs_runtime_reads"))
    .map((line) => JSON.parse(line));
}

describe("traced runtime calls", () => {
  test("an untraced call keeps the old answer shape", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const set = showcaseSet();

    const result = await runResolvedRuntimeRequest(createEnv(set.objects), {
      resolution: set.resolution,
      operation: "getRouteData",
      payload: { pathname: "/" },
    });

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty("timing");
  });

  test("a traced route-data call answers with timing and logs the trace", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const set = showcaseSet();

    const result = await runResolvedRuntimeRequest(createEnv(set.objects), {
      resolution: set.resolution,
      operation: "getRouteData",
      payload: { pathname: "/" },
      trace: TRACE,
    });

    expect(result.ok).toBe(true);
    const timing = readDocsRuntimeCallTiming(result.timing);
    expect(timing).toBeDefined();
    expect(timing).toMatchObject({
      versionColdInIsolate: true,
      isolate: { requests: 1 },
    });
    expect(timing?.reads).toBeGreaterThan(0);
    expect(timing?.firstReadMs).toBeGreaterThanOrEqual(0);
    expect(timing?.responseBytes).toBeGreaterThan(0);
    expect(timing?.totalMs).toBeGreaterThanOrEqual(timing?.operationMs ?? 0);

    const [line] = readsLines(info);
    expect(line).toMatchObject({
      event: "docs_runtime_reads",
      ok: true,
      traceId: TRACE.id,
      caller: "prefetch",
      isolate: { id: timing?.isolate.id, requests: 1 },
      versionColdInIsolate: true,
    });
    expect(line).toHaveProperty("manifestMs");
    expect(line).toHaveProperty("operationMs");
  });

  test("a second call of the same version is warm in the isolate", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const set = showcaseSet();
    const env = createEnv(set.objects);
    const call = () =>
      runResolvedRuntimeRequest(env, {
        resolution: set.resolution,
        operation: "getRouteData",
        payload: { pathname: "/" },
        trace: TRACE,
      });

    const first = readDocsRuntimeCallTiming((await call()).timing);
    const second = readDocsRuntimeCallTiming((await call()).timing);

    expect(first?.versionColdInIsolate).toBe(true);
    expect(second?.versionColdInIsolate).toBe(false);
    expect(second?.isolate.id).toBe(first?.isolate.id);
    expect(second?.isolate.requests).toBe(2);
  });

  test("an invalid trace counts as no trace", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const set = showcaseSet();

    const result = await runResolvedRuntimeRequest(createEnv(set.objects), {
      resolution: set.resolution,
      operation: "getRouteData",
      payload: { pathname: "/" },
      trace: { id: "not-a-uuid", caller: "prefetch" },
    });

    expect(result).not.toHaveProperty("timing");
    expect(readsLines(info)[0]).not.toHaveProperty("traceId");
  });

  test("logs an invalid request without the payload", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await runResolvedRuntimeRequest(createEnv({}), {
      resolution: { secret: "resolution-secret" } as never,
      operation: "getRouteData",
      payload: { pathname: "/payload-secret" },
      trace: TRACE,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    const lines = readsLines(warn);
    expect(lines).toEqual([
      {
        event: "docs_runtime_reads",
        operation: "getRouteData",
        siteId: null,
        publishedVersionId: null,
        ok: false,
        errorCode: "invalid_request",
        traceId: TRACE.id,
        caller: "prefetch",
        isolate: expect.objectContaining({ requests: 1 }),
      },
    ]);
    const raw = String(warn.mock.calls[0]?.[0]);
    expect(raw).not.toContain("secret");
  });

  test("logs a missing version without the payload", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const set = showcaseSet();

    const result = await runResolvedRuntimeRequest(createEnv({}), {
      resolution: set.resolution,
      operation: "getPage",
      payload: { pathname: "/payload-secret" },
      trace: { ...TRACE, caller: "content" },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "version_not_found" },
    });
    expect(readDocsRuntimeCallTiming(result.timing)).toBeDefined();
    const [line] = readsLines(warn);
    expect(line).toMatchObject({
      event: "docs_runtime_reads",
      operation: "getPage",
      siteId: set.resolution.siteId,
      publishedVersionId: set.resolution.publishedVersionId,
      ok: false,
      errorCode: "version_not_found",
      traceId: TRACE.id,
      caller: "content",
      versionColdInIsolate: true,
    });
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("payload-secret");
  });
});

describe("isolate facts", () => {
  test("keep one ID and count calls", () => {
    let next = 0;
    const createId = () => `isolate-${(next += 1)}`;

    const first = recordIsolateRequest(1_000, createId);
    const second = recordIsolateRequest(1_250, createId);

    expect(first).toEqual({ id: "isolate-1", requests: 1, ageMs: 0 });
    expect(second).toEqual({ id: "isolate-1", requests: 2, ageMs: 250 });
  });

  test("remember a bounded number of versions", () => {
    expect(markVersionSeen("version-0")).toBe(true);
    for (let index = 1; index <= 1_000; index += 1) {
      markVersionSeen(`version-${index}`);
    }
    // version-0 was the oldest, so the full set forgot it.
    expect(markVersionSeen("version-0")).toBe(true);
    expect(markVersionSeen("version-1000")).toBe(false);
  });
});
