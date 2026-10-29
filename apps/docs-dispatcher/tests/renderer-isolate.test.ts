import type { DocsHostResolution } from "@doxahq/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  isRendererPropsMissing,
  logRendererUse,
  openRendererIsolate,
  readSharedIsolateRollout,
  selectRendererIsolateScope,
  type RendererIsolateEnv,
} from "../src/renderer-isolate";
import { createServerTiming } from "../src/server-timing";
import type { DocsRuntimeRpc } from "../src/worker-exports";

vi.mock("../src/renderer-code-package", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/renderer-code-package")>()),
  loadRendererCodePackage: vi.fn(async () => ({
    code: {
      schemaVersion: 1,
      buildId: "build-1",
      compatibilityDate: "2026-06-12",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "index.js",
      modules: { "index.js": "export default {}" },
    },
    source: "cache",
  })),
}));

const SITE_A = "site-a";

function resolutionFor(siteId: string): DocsHostResolution {
  return {
    siteId,
    projectId: `project-${siteId}`,
    projectSlug: siteId,
    publishedVersionId: `version-${siteId}`,
    artifactPrefix: `sites/${siteId}/versions/v1`,
    manifestPath: `sites/${siteId}/versions/v1/manifest.json`,
    accessPolicy: "public",
  };
}

type GetCode = Parameters<WorkerLoader["get"]>[1];

/** A loader that starts the isolate on `get`, like a cold start. */
function createEnv(overrides: Partial<RendererIsolateEnv> = {}) {
  const getEntrypoint = vi.fn(() => ({ fetch: vi.fn() }));
  const loads: { id: string | null; code: Awaited<ReturnType<GetCode>> }[] =
    [];
  const pending: Promise<void>[] = [];
  const get = vi.fn((id: string | null, getCode: GetCode) => {
    pending.push(
      Promise.resolve(getCode()).then((code) => {
        loads.push({ id, code });
      }),
    );
    return { getEntrypoint, getDurableObjectClass: vi.fn() };
  });
  const env: RendererIsolateEnv = {
    LOADER: { get, load: vi.fn() } as unknown as WorkerLoader,
    RENDERER_CODE_BUCKET: {} as R2Bucket,
    DOXA_RENDERER_BUILD_ID: "build-1",
    DOXA_RENDERER_PACKAGE_KEY: "renderer-code/build-1.json.gz",
    DOXA_API_BASE_URL: "https://api.doxa.so",
    ...overrides,
  };
  return { env, get, getEntrypoint, loads, settle: () => Promise.all(pending) };
}

function open(env: RendererIsolateEnv, siteId = SITE_A) {
  const content = { request: vi.fn() } as unknown as DocsRuntimeRpc;
  const isolate = openRendererIsolate({
    env,
    resolution: resolutionFor(siteId),
    content,
    codeCache: vi.fn(),
    timing: createServerTiming("false"),
  });
  return { isolate, content };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shared-isolate rollout", () => {
  test("keeps every site in its own isolate by default", () => {
    const rollout = readSharedIsolateRollout({});
    expect(selectRendererIsolateScope(rollout, SITE_A)).toBe("site");
  });

  test("shares the build isolate only for allowlisted sites", () => {
    const rollout = readSharedIsolateRollout({
      DOXA_PROD_SHARED_ISOLATE_MODE: "allowlist",
      DOXA_PROD_SHARED_ISOLATE_SITE_IDS: ` ${SITE_A} ,site-c`,
    });
    expect(selectRendererIsolateScope(rollout, SITE_A)).toBe("build");
    expect(selectRendererIsolateScope(rollout, "site-b")).toBe("site");
  });

  test("an invalid mode fails closed to one isolate per site", () => {
    const warn = vi.fn();
    const rollout = readSharedIsolateRollout(
      { DOXA_PROD_SHARED_ISOLATE_MODE: "everything" },
      warn,
    );
    expect(selectRendererIsolateScope(rollout, SITE_A)).toBe("site");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("DOXA_PROD_SHARED_ISOLATE_MODE"),
    );
  });
});

describe("openRendererIsolate", () => {
  test("site scope pins the content in the isolate env", async () => {
    const { env, get, getEntrypoint, loads, settle } = createEnv();
    const { isolate, content } = open(env);

    isolate.getEntrypoint();
    await settle();

    expect(isolate.scope).toBe("site");
    expect(get).toHaveBeenCalledWith(
      "docs:site-a:version-site-a:build-1",
      expect.any(Function),
    );
    expect(loads[0]?.code.env).toMatchObject({
      DOXA_DOCS_RUNTIME_SOURCE: "binding",
      DOXA_DOCS_CONTENT_BINDING: content,
      DOXA_DOCS_CONTENT_RESOLUTION: resolutionFor(SITE_A),
    });
    expect(getEntrypoint).toHaveBeenCalledWith(undefined, undefined);
    expect(isolate.cold).toBe(true);
  });

  test("limits each call to 5 s of CPU and 50 subrequests (M46)", async () => {
    const { env, loads, settle } = createEnv({
      DOXA_PROD_SHARED_ISOLATE_MODE: "all",
    });
    open(env).isolate.getEntrypoint();
    await settle();
    expect(loads[0]?.code.limits).toEqual({ cpuMs: 5_000, subRequests: 3_000 });
  });

  test("build scope keeps site content out of the env and sends it as props", async () => {
    const { env, get, getEntrypoint, loads, settle } = createEnv({
      DOXA_PROD_SHARED_ISOLATE_MODE: "all",
    });
    const { isolate, content } = open(env);

    isolate.getEntrypoint("DocsPrerenderRenderer");
    await settle();

    expect(isolate.scope).toBe("build");
    expect(get).toHaveBeenCalledWith("docs:build:build-1", expect.any(Function));
    const isolateEnv = loads[0]?.code.env ?? {};
    expect(isolateEnv).toEqual({
      DOXA_DOCS_RUNTIME_SOURCE: "binding",
      DOXA_API_BASE_URL: "https://api.doxa.so",
    });
    expect(getEntrypoint).toHaveBeenCalledWith("DocsPrerenderRenderer", {
      props: { content, resolution: resolutionFor(SITE_A) },
    });
  });

  test("runs onColdStart only when this request starts the isolate", async () => {
    const { env, settle } = createEnv();
    const onColdStart = vi.fn();
    const isolate = openRendererIsolate({
      env,
      resolution: resolutionFor(SITE_A),
      content: { request: vi.fn() } as unknown as DocsRuntimeRpc,
      codeCache: vi.fn(),
      timing: createServerTiming("false"),
      onColdStart,
    });
    await settle();
    expect(isolate.cold).toBe(true);
    expect(onColdStart).toHaveBeenCalledOnce();

    const warmGet = vi.fn(() => ({
      getEntrypoint: vi.fn(),
      getDurableObjectClass: vi.fn(),
    }));
    const warmColdStart = vi.fn();
    openRendererIsolate({
      env: {
        ...env,
        LOADER: { get: warmGet, load: vi.fn() } as unknown as WorkerLoader,
      },
      resolution: resolutionFor(SITE_A),
      content: { request: vi.fn() } as unknown as DocsRuntimeRpc,
      codeCache: vi.fn(),
      timing: createServerTiming("false"),
      onColdStart: warmColdStart,
    });
    expect(warmColdStart).not.toHaveBeenCalled();
  });

  test("two sites in build scope share one isolate ID", () => {
    const { env, get } = createEnv({ DOXA_PROD_SHARED_ISOLATE_MODE: "all" });
    open(env, SITE_A);
    open(env, "site-b");
    expect(get.mock.calls.map(([id]) => id)).toEqual([
      "docs:build:build-1",
      "docs:build:build-1",
    ]);
  });
});

describe("logRendererUse", () => {
  test("logs the scope, the build and the cold start of one call", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { env, settle } = createEnv({ DOXA_PROD_SHARED_ISOLATE_MODE: "all" });
    const { isolate } = open(env);
    isolate.getEntrypoint();
    await settle();

    logRendererUse(isolate, {
      entrypoint: "prepare",
      resolution: resolutionFor(SITE_A),
      startedAt: Date.now(),
      outcome: { ok: false, error: "Error: boom" },
    });

    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toEqual({
      event: "docs_renderer_load",
      entrypoint: "prepare",
      siteId: SITE_A,
      publishedVersionId: "version-site-a",
      isolateScope: "build",
      rendererBuildId: "build-1",
      state: "COLD",
      codeLoadMs: expect.any(Number),
      codeSource: "cache",
      totalMs: expect.any(Number),
      ok: false,
      error: "Error: boom",
    });
  });
});

describe("renderer_props_missing (F35)", () => {
  test("reads the code from a response header or an RPC error message", () => {
    expect(
      isRendererPropsMissing(
        new Response(null, {
          status: 500,
          headers: { "x-doxa-renderer-error": "renderer_props_missing" },
        }),
      ),
    ).toBe(true);
    expect(
      isRendererPropsMissing(new Error("[renderer_props_missing] no scope")),
    ).toBe(true);
    expect(isRendererPropsMissing("Error: [renderer_props_missing] x")).toBe(
      true,
    );
    expect(isRendererPropsMissing(new Response(null, { status: 500 }))).toBe(
      false,
    );
    expect(isRendererPropsMissing(new Error("boom"))).toBe(false);
  });

  test("a prepare call that failed for missing props gets its own log", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { env } = createEnv({ DOXA_PROD_SHARED_ISOLATE_MODE: "all" });
    const { isolate } = open(env);

    logRendererUse(isolate, {
      entrypoint: "prepare",
      resolution: resolutionFor(SITE_A),
      startedAt: Date.now(),
      outcome: {
        ok: false,
        error:
          "Error: [renderer_props_missing] The renderer call has no request scope.",
      },
    });

    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
      event: "renderer_props_missing",
      entrypoint: "prepare",
      siteId: SITE_A,
      publishedVersionId: "version-site-a",
      fallback: false,
    });
  });
});
