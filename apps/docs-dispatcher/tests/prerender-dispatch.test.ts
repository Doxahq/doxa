import type { DocsDomainResolution } from "@doxahq/contracts";
import {
  createPrerenderManifestKey,
  createPrerenderObjectKey,
} from "@doxahq/contracts/docs-prerender";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));

import worker, { DocsHostCache, DocsPrerenderCache } from "../src/index";
import { clearRepairCooldowns } from "../src/prerender-cache-entrypoint";
import { createExpectedPrerenderIdentity } from "../src/prerender-policy";
import { createRouteData } from "./fixtures/route-data";

describe("pre-render dispatcher paths", () => {
  beforeEach(() => {
    clearRepairCooldowns();
  });

  test("serves saved HTML without invoking a renderer", async () => {
    const fixture = await createFixture();
    const response = await worker.fetch(
      new Request("https://docs.example.com/guide", {
        headers: { accept: "text/html" },
      }),
      fixture.env as never,
      fixture.ctx as never,
    );

    expect(await response.text()).toBe("<!doctype html><p>Saved guide</p>");
    expect(response.headers.get("x-doxa-representation-source")).toBe(
      "prerender",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(fixture.env.LOADER.get).not.toHaveBeenCalled();
    expect(fixture.prepare).not.toHaveBeenCalled();
  });

  test.each<{ name: string; headers: Record<string, string> }>([
    {
      name: "browser reload",
      headers: { "cache-control": "max-age=0" },
    },
    {
      name: "explicit revalidation",
      headers: { "cache-control": "no-cache" },
    },
    {
      name: "legacy revalidation",
      headers: { pragma: "no-cache" },
    },
  ])("serves saved HTML for a $name request", async ({ headers }) => {
    const fixture = await createFixture();
    const response = await worker.fetch(
      new Request("https://docs.example.com/guide", {
        headers: { accept: "text/html", ...headers },
      }),
      fixture.env as never,
      fixture.ctx as never,
    );

    expect(await response.text()).toBe("<!doctype html><p>Saved guide</p>");
    // The hostname cache stub reports no cf-cache-status.
    expect(response.headers.get("x-doxa-host-cache")).toBe("UNAVAILABLE");
    expect(response.headers.get("x-doxa-html-cache")).toBe("PRERENDER");
    expect(response.headers.get("x-doxa-representation-source")).toBe(
      "prerender",
    );
    expect(fixture.env.LOADER.get).not.toHaveBeenCalled();
    expect(fixture.prepare).not.toHaveBeenCalled();
  });

  test("serves saved route data and rejects a forged render hint", async () => {
    const fixture = await createFixture();
    const response = await worker.fetch(
      new Request(
        `https://docs.example.com/_doxa/route-data/v1?path=%2Fguide&render=${fixture.identity.renderId}`,
        { headers: { accept: "application/json" } },
      ),
      fixture.env as never,
      fixture.ctx as never,
    );
    expect(await response.json()).toMatchObject({
      status: "ok",
      renderId: fixture.identity.renderId,
      data: { type: "page", href: "/guide" },
    });
    expect(fixture.prepare).not.toHaveBeenCalled();

    const mismatch = await worker.fetch(
      new Request(
        `https://docs.example.com/_doxa/route-data/v1?path=%2Fguide&render=${"f".repeat(64)}`,
      ),
      fixture.env as never,
      fixture.ctx as never,
    );
    expect(mismatch.status).toBe(409);
  });

  test("uses GET for a saved HEAD lookup so an empty response cannot poison GET", async () => {
    const fixture = await createFixture();
    const response = await worker.fetch(
      new Request("https://docs.example.com/guide", {
        method: "HEAD",
        headers: { accept: "text/html" },
      }),
      fixture.env as never,
      fixture.ctx as never,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(fixture.prerenderFetchMethods).toEqual(["GET"]);
  });

  test("caches live HTML fallback for only 30 seconds after a saved-output miss", async () => {
    const fixture = await createFixture({ includeSavedOutput: false });
    fixture.env.DOXA_PROD_DYNAMIC_RENDERER_MODE = "all";
    const htmlFetch = vi.fn(
      async () =>
        new Response("<!doctype html><p>Live guide</p>", {
          headers: {
            "content-type": "text/html",
            "cf-cache-status": "MISS",
          },
        }),
    );
    fixture.ctx.exports.DocsHtmlCache = vi.fn(() => ({ fetch: htmlFetch }));

    const response = await worker.fetch(
      new Request("https://docs.example.com/guide", {
        headers: { accept: "text/html" },
      }),
      fixture.env as never,
      fixture.ctx as never,
    );

    expect(await response.text()).toContain("Live guide");
    expect(fixture.ctx.exports.DocsHtmlCache).toHaveBeenCalledWith({
      props: expect.objectContaining({ lifetime: "liveFallback" }),
    });
  });

  test("exposes saved-output lookup details only when DEBUG is true", async () => {
    const fixture = await createFixture({ includeSavedOutput: false });
    fixture.env.DEBUG = "true";
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await worker.fetch(
      new Request("https://docs.example.com/guide", {
        headers: { accept: "text/html" },
      }),
      fixture.env as never,
      fixture.ctx as never,
    );

    expect(response.headers.get("x-doxa-prerender-lookup")).toBe("miss");
    expect(response.headers.get("x-doxa-prerender-reason")).toBe(
      "manifest_missing",
    );
    expect(response.headers.get("x-doxa-prerender-cache")).toBe("BYPASS");
    expect(response.headers.get("server-timing")).toContain(
      'doxa_prerender_manifest_get;dur=',
    );
    expect(response.headers.get("server-timing")).toContain(
      'desc="MISS"',
    );
    expect(response.headers.get("server-timing")).toContain(
      'doxa_prerender_lookup;dur=',
    );
    expect(response.headers.get("server-timing")).toContain(
      'desc="miss:manifest_missing"',
    );
    expect(response.headers.has("x-doxa-internal-server-timing")).toBe(false);
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({
      prerender: {
        cache: "BYPASS",
        lookup: "miss",
        reason: "manifest_missing",
      },
    });
    info.mockRestore();
  });

  test("does not expose saved-output lookup details when DEBUG is false", async () => {
    const fixture = await createFixture({ includeSavedOutput: false });
    fixture.env.DEBUG = "false";

    const response = await worker.fetch(
      new Request("https://docs.example.com/guide", {
        headers: { accept: "text/html" },
      }),
      fixture.env as never,
      fixture.ctx as never,
    );

    expect(response.headers.has("x-doxa-prerender-lookup")).toBe(false);
    expect(response.headers.has("x-doxa-prerender-reason")).toBe(false);
    expect(response.headers.has("x-doxa-prerender-cache")).toBe(false);
    expect(response.headers.has("server-timing")).toBe(false);
  });

  test("uses one live data preparation after a saved-data miss", async () => {
    const fixture = await createFixture({ includeSavedOutput: false });
    fixture.prepare.mockResolvedValue(createRouteData());

    const response = await worker.fetch(
      new Request(
        `https://docs.example.com/_doxa/route-data/v1?path=%2Fguide&render=${fixture.identity.renderId}`,
      ),
      fixture.env as never,
      fixture.ctx as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-doxa-representation-source")).toBe(
      "dynamic",
    );
    expect(await response.json()).toMatchObject({
      status: "ok",
      data: { type: "page", href: "/guide" },
    });
    expect(fixture.prepare).toHaveBeenCalledOnce();
  });

  test("submits bounded repair work for a missing manifest and logs submission failure", async () => {
    const fixture = await createFixture({ includeSavedOutput: false });
    const enqueueRepair = vi.fn(async () => {
      throw new Error(`API unavailable ${"x".repeat(500)}`);
    });
    fixture.env.DOXA_PRERENDER_REPAIR_ENABLED = "true";
    fixture.env.PRERENDER_TASKS = { enqueueRepair };
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await worker.fetch(
      new Request("https://docs.example.com/guide", {
        headers: { accept: "text/html" },
      }),
      fixture.env as never,
      fixture.ctx as never,
    );
    await Promise.all(fixture.backgroundTasks);

    expect(enqueueRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/guide",
        reason: "manifest_missing",
        identity: fixture.identity,
      }),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '"eventType":"docs_prerender_repair_enqueue_failed"',
      ),
    );
    expect(consoleSpy.mock.calls[0]?.[0]).not.toContain("x".repeat(400));
    consoleSpy.mockRestore();
  });

  test("submits repair work once for repeated requests to one render", async () => {
    const fixture = await createFixture({ includeSavedOutput: false });
    const enqueueRepair = vi.fn(async () => ({ status: "accepted" as const }));
    fixture.env.DOXA_PRERENDER_REPAIR_ENABLED = "true";
    fixture.env.PRERENDER_TASKS = { enqueueRepair };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await worker.fetch(
        new Request("https://docs.example.com/guide", {
          headers: { accept: "text/html" },
        }),
        fixture.env as never,
        fixture.ctx as never,
      );
    }
    await Promise.all(fixture.backgroundTasks);

    expect(enqueueRepair).toHaveBeenCalledOnce();
  });

  test("sends one security header set for saved and live HTML", async () => {
    const saved = await createFixture();
    const savedResponse = await worker.fetch(
      new Request("https://docs.example.com/guide", {
        headers: { accept: "text/html" },
      }),
      saved.env as never,
      saved.ctx as never,
    );

    const live = await createFixture({ includeSavedOutput: false });
    const liveResponse = await worker.fetch(
      new Request("https://docs.example.com/guide", {
        headers: { accept: "text/html" },
      }),
      live.env as never,
      live.ctx as never,
    );

    for (const response of [savedResponse, liveResponse]) {
      expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe(
        "strict-origin-when-cross-origin",
      );
      expect(response.headers.get("permissions-policy")).toBe(
        "camera=(), microphone=(), geolocation=()",
      );
    }
  });

  test("does not submit repair work for an unknown route in a valid manifest", async () => {
    const fixture = await createFixture();
    const enqueueRepair = vi.fn();
    fixture.env.DOXA_PRERENDER_REPAIR_ENABLED = "true";
    fixture.env.PRERENDER_TASKS = { enqueueRepair };

    await worker.fetch(
      new Request("https://docs.example.com/unknown", {
        headers: { accept: "text/html" },
      }),
      fixture.env as never,
      fixture.ctx as never,
    );
    await Promise.all(fixture.backgroundTasks);

    expect(enqueueRepair).not.toHaveBeenCalled();
  });
});

const resolution: DocsDomainResolution = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "published-2",
  artifactPrefix: "sites/site-1/versions/source-1",
  manifestPath: "sites/site-1/versions/source-1/manifest.json",
  accessPolicy: "public",
  hostname: "docs.example.com",
  domainKind: "custom_domain",
  renderTarget: "production",
};

async function createFixture(options: { includeSavedOutput?: boolean } = {}) {
  const includeSavedOutput = options.includeSavedOutput ?? true;
  const rendererReleaseId = "a".repeat(64);
  const identity = await createExpectedPrerenderIdentity({
    siteId: resolution.siteId,
    artifactPrefix: resolution.artifactPrefix,
    manifestPath: resolution.manifestPath,
    rendererReleaseId,
    trustedRequestOrigin: "https://docs.example.com",
  });
  const html = encode("<!doctype html><p>Saved guide</p>");
  const data = encode(JSON.stringify(createRouteData()));
  const htmlDigest = await digest(html);
  const dataDigest = await digest(data);
  const manifest = {
    schemaVersion: 1,
    identity,
    completedAt: "2026-09-19T20:00:00.000Z",
    routes: [
      {
        kind: "page",
        pathname: "/guide",
        html: {
          digest: htmlDigest,
          byteLength: html.byteLength,
          contentType: "text/html; charset=utf-8",
          objectName: `objects/${htmlDigest}.html`,
        },
        data: {
          digest: dataDigest,
          byteLength: data.byteLength,
          contentType: "application/json; charset=utf-8",
          objectName: `objects/${dataDigest}.json`,
        },
      },
    ],
  };
  const objects = new Map<string, Uint8Array>(
    includeSavedOutput
      ? [
          [
            createPrerenderManifestKey(identity.siteId, identity.renderId),
            encode(JSON.stringify(manifest)),
          ],
          [
            createPrerenderObjectKey(
              identity.siteId,
              identity.renderId,
              htmlDigest,
              "html",
            ),
            html,
          ],
          [
            createPrerenderObjectKey(
              identity.siteId,
              identity.renderId,
              dataDigest,
              "json",
            ),
            data,
          ],
        ]
      : [],
  );
  const bucket = {
    get: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      return bytes
        ? {
            size: bytes.byteLength,
            arrayBuffer: async () => bytes.slice().buffer,
          }
        : null;
    }),
  };
  const prepare = vi.fn();
  const prerenderFetchMethods: string[] = [];
  const backgroundTasks: Promise<unknown>[] = [];
  const env = {
    DEBUG: undefined as string | undefined,
    DOCS_RESOLVER: {
      fetch: vi.fn(async () => Response.json({ resolution })),
    },
    SHARED_RENDERER: { fetch: vi.fn(async () => new Response("shared")) },
    LOADER: { get: vi.fn() },
    DOCS_RENDERED_BUCKET: bucket,
    DOXA_PROD_PRERENDER_MODE: "all",
    DOXA_RENDERER_RELEASE_ID: rendererReleaseId,
    DOXA_RENDERER_BUILD_ID: "build-1",
    DOXA_PROD_DYNAMIC_RENDERER_MODE: "off",
    DOXA_PRERENDER_REPAIR_ENABLED: undefined as string | undefined,
    PRERENDER_TASKS: undefined as
      | { enqueueRepair: ReturnType<typeof vi.fn> }
      | undefined,
  };
  const ctx = {
    waitUntil: vi.fn((task: Promise<unknown>) => {
      backgroundTasks.push(task);
    }),
    exports: {
      DocsHostCache: ({ props }: { props: { hostname: string } }) =>
        new DocsHostCache({ props } as never, env as never),
      DocsPrerenderCache: ({ props }: { props: never }) => ({
        fetch: (request: Request) => {
          prerenderFetchMethods.push(request.method);
          return new DocsPrerenderCache(
            {
              props,
              exports: ctx.exports,
              waitUntil: ctx.waitUntil,
            } as never,
            env as never,
          ).fetch(request);
        },
      }),
      DocsHtmlCache: vi.fn(),
      PrerenderRendererApi: () => ({ prepare }),
    },
  };
  return {
    ctx,
    env,
    identity,
    prepare,
    prerenderFetchMethods,
    backgroundTasks,
  };
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function digest(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  const result = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(result)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
