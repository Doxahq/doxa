/**
 * M46: every site shares one renderer isolate per build. Each call must
 * carry its own site's props, whichever path opens the isolate and however
 * the calls of two sites interleave.
 */
import type { DocsDomainResolution } from "@doxahq/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
  // The warm Durable Objects (M28) are exported from the same module.
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));

import worker, {
  DocsHostCache,
  DocsHtmlCache,
  PrerenderRendererApi,
} from "../src/index";
import { createRouteData } from "./fixtures/route-data";

const SITES = ["site-alpha", "site-bravo"] as const;
type SiteId = (typeof SITES)[number];

function resolutionFor(siteId: SiteId): DocsDomainResolution {
  return {
    siteId,
    projectId: `project-${siteId}`,
    projectSlug: siteId,
    publishedVersionId: `version-${siteId}`,
    artifactPrefix: `sites/${siteId}/versions/v1`,
    manifestPath: `sites/${siteId}/versions/v1/manifest.json`,
    accessPolicy: "public",
    hostname: `${siteId}.doxa.page`,
    domainKind: "doxa_subdomain",
    renderTarget: "production",
  };
}

function siteOfHostname(hostname: string): SiteId | undefined {
  return SITES.find((site) => hostname === `${site}.doxa.page`);
}

/** What one renderer call saw: the site it served and the props it got. */
interface RendererCall {
  isolateId: string | null;
  entrypoint: string;
  /** The site the dispatcher was asked to serve, read from the call input. */
  requestedSite: SiteId | undefined;
  propsSite: string | undefined;
  contentSite: string | undefined;
}

interface ScopedContentStub {
  request: () => Promise<never>;
  /** Test-only tag: the site whose props created this binding. */
  boundSiteId: string;
}

function readProps(options: unknown): {
  propsSite: string | undefined;
  contentSite: string | undefined;
} {
  const props: unknown =
    typeof options === "object" && options !== null
      ? Reflect.get(options, "props")
      : undefined;
  if (typeof props !== "object" || props === null) {
    return { propsSite: undefined, contentSite: undefined };
  }
  const resolution: unknown = Reflect.get(props, "resolution");
  const content: unknown = Reflect.get(props, "content");
  const siteId: unknown =
    typeof resolution === "object" && resolution !== null
      ? Reflect.get(resolution, "siteId")
      : undefined;
  const bound: unknown =
    typeof content === "object" && content !== null
      ? Reflect.get(content, "boundSiteId")
      : undefined;
  return {
    propsSite: typeof siteId === "string" ? siteId : undefined,
    contentSite: typeof bound === "string" ? bound : undefined,
  };
}

const randomDelay = () =>
  new Promise((resolve) => setTimeout(resolve, Math.random() * 5));

/**
 * A Worker Loader that keeps one isolate per ID and records the props of
 * every entrypoint it hands out. Each entrypoint waits a random time, so the
 * calls of the two sites interleave.
 */
function createRecordingLoader() {
  const calls: RendererCall[] = [];
  const record = (
    isolateId: string | null,
    entrypoint: string,
    options: unknown,
    requestedSite: SiteId | undefined,
  ) => {
    calls.push({ isolateId, entrypoint, requestedSite, ...readProps(options) });
    return readProps(options);
  };
  const get = vi.fn((isolateId: string | null) => ({
    getEntrypoint: (name: string | undefined, options: unknown) =>
      name === "DocsPrerenderRenderer"
        ? {
            async prepare(input: { pathname: string }) {
              await randomDelay();
              record(isolateId, "prepare", options, siteOfPath(input.pathname));
              return createRouteData();
            },
            async render(input: { requestUrl: string }) {
              await randomDelay();
              const { propsSite } = record(
                isolateId,
                "render",
                options,
                siteOfHostname(new URL(input.requestUrl).hostname),
              );
              return new Response(`render:${propsSite}`);
            },
          }
        : {
            async fetch(request: Request) {
              await randomDelay();
              const { propsSite } = record(
                isolateId,
                "fetch",
                options,
                siteOfHostname(new URL(request.url).hostname),
              );
              return new Response(`html:${propsSite}`, {
                headers: { "content-type": "text/html" },
              });
            },
          },
    getDurableObjectClass: vi.fn(),
  }));
  return { loader: { get, load: vi.fn() }, calls };
}

function siteOfPath(pathname: string): SiteId | undefined {
  return SITES.find((site) => pathname === `/${site}-page`);
}

function createEnv(loader: ReturnType<typeof createRecordingLoader>["loader"]) {
  return {
    DOCS_RESOLVER: {
      fetch: vi.fn(async (request: Request) => {
        const body: unknown = await request.json();
        const hostname =
          typeof body === "object" && body !== null
            ? Reflect.get(body, "value")
            : undefined;
        const site =
          typeof hostname === "string" ? siteOfHostname(hostname) : undefined;
        return Response.json({ resolution: site ? resolutionFor(site) : null });
      }),
    },
    SHARED_RENDERER: { fetch: vi.fn(async () => new Response("shared")) },
    LOADER: loader,
    DOXA_PROD_DYNAMIC_RENDERER_MODE: "all",
    DOXA_PROD_SHARED_ISOLATE_MODE: "all",
    DOXA_RENDERER_BUILD_ID: "build-1",
    DOXA_RENDERER_PACKAGE_KEY: "renderer-code/build-1.json.gz",
  };
}

function createExports(env: ReturnType<typeof createEnv>) {
  return {
    ScopedDocsContent: vi.fn(
      ({
        props,
      }: {
        props: { resolution: DocsDomainResolution };
      }): ScopedContentStub => ({
        request: async () => {
          throw new Error("The fake renderer reads no content.");
        },
        boundSiteId: props.resolution.siteId,
      }),
    ),
    DocsRendererCodeCache: vi.fn(),
    DocsHostCache: ({ props }: { props: { hostname: string } }) =>
      new DocsHostCache({ props } as never, env as never),
  };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shared renderer isolate props (M46, F13)", () => {
  test("two interleaved sites on one isolate ID each get their own props", async () => {
    const { loader, calls } = createRecordingLoader();
    const env = createEnv(loader);
    const exports = createExports(env);

    const htmlCacheFill = (site: SiteId) =>
      new DocsHtmlCache(
        {
          props: {
            hostname: `${site}.doxa.page`,
            rendererBuildId: "build-1",
            resolution: resolutionFor(site),
            lifetime: "versioned",
            deliveryRenderId: null,
          },
          exports,
        } as never,
        env as never,
      ).fetch(
        new Request(`https://${site}.doxa.page/guide`, {
          headers: { accept: "text/html" },
        }),
      );
    // A visitor-specific request skips the HTML cache and renders directly.
    const uncachedFetch = (site: SiteId) =>
      worker.fetch(
        new Request(`https://${site}.doxa.page/guide`, {
          headers: { accept: "text/html", cookie: "visitor=1" },
        }),
        env as never,
        { exports, waitUntil: vi.fn() } as never,
      );
    const prerender = () =>
      new PrerenderRendererApi({ exports } as never, env as never);
    const prepare = (site: SiteId) =>
      prerender().prepare({
        resolution: resolutionFor(site),
        pathname: `/${site}-page`,
      });
    const render = (site: SiteId) =>
      prerender().render({
        resolution: resolutionFor(site),
        pathname: "/guide",
        requestUrl: `https://${site}.doxa.page/guide`,
        renderId: "a".repeat(64),
        routeData: createRouteData() as never,
      });

    const paths = [htmlCacheFill, uncachedFetch, prepare, render];
    const jobs = Array.from({ length: 64 }, (_, index) => {
      const site = SITES[index % 2];
      const path = paths[Math.floor(index / 2) % paths.length];
      return { site, run: () => path(site) };
    });
    const results = await Promise.all(jobs.map((job) => job.run()));

    for (const [index, result] of results.entries()) {
      const site = jobs[index].site;
      if (result instanceof Response) {
        const text = await result.text();
        expect(text).toContain(site);
        expect(text).not.toContain(SITES.find((other) => other !== site));
      }
    }
    expect(calls).toHaveLength(64);
    expect(new Set(calls.map((call) => call.isolateId))).toEqual(
      new Set(["docs:build:build-1"]),
    );
    expect(new Set(calls.map((call) => call.entrypoint))).toEqual(
      new Set(["fetch", "prepare", "render"]),
    );
    for (const call of calls) {
      expect(call.requestedSite).toBeDefined();
      expect(call.propsSite).toBe(call.requestedSite);
      expect(call.contentSite).toBe(call.requestedSite);
    }
  });
});
