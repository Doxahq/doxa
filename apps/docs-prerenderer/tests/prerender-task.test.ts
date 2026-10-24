import { describe, expect, test, vi } from "vitest";

import type { PublicDocsRouteDataV1 } from "@doxahq/contracts/docs-prerender";

import { executePrerenderTask } from "../src/prerender-task";

describe("pre-render task", () => {
  test("renders at most four routes concurrently and commits the manifest last", async () => {
    let active = 0;
    let maximumActive = 0;
    const renderer = {
      getPlan: vi.fn(async () =>
        Array.from({ length: 6 }, (_, index) => ({
          kind: "page" as const,
          pathname: `/page-${index}`,
        })),
      ),
      prepare: vi.fn(async (pathname: string) => createPageData(pathname)),
      render: vi.fn(async ({ pathname }: { pathname: string }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return new Response(`<!doctype html><p>${pathname}</p>`, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }),
    };
    const bucket = createBucket();

    const result = await executePrerenderTask({
      identity,
      renderer,
      bucket,
      now: () => new Date("2026-09-19T20:00:00.000Z"),
    });

    expect(result).toEqual({ status: "committed", routeCount: 6 });
    expect(maximumActive).toBeLessThanOrEqual(4);
    expect(bucket.writes.at(-1)).toMatch(/manifest\.json$/);
    expect(
      bucket.writes.slice(0, -1).every((key) => key.includes("/objects/")),
    ).toBe(true);
  });

  test("stores explicit live-only entries when a valid route exceeds static limits", async () => {
    const bucket = createBucket();
    await executePrerenderTask({
      identity,
      renderer: {
        getPlan: async () => [{ kind: "page", pathname: "/large" }],
        prepare: async () => createPageData("/large"),
        render: async () =>
          new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
            headers: { "content-type": "text/html" },
          }),
      },
      bucket,
      now: () => new Date("2026-09-19T20:00:00.000Z"),
    });

    const manifest = bucket.readManifest();
    expect(manifest.routes).toEqual([
      { kind: "live_only", pathname: "/large", reason: "html_too_large" },
    ]);
  });

  test("commits planned live-only routes without calling the renderer", async () => {
    const bucket = createBucket();
    const prepare = vi.fn();
    const render = vi.fn();

    await executePrerenderTask({
      identity,
      renderer: {
        getPlan: async () => [
          { kind: "live_only", pathname: "/", reason: "unsupported_route" },
        ],
        prepare,
        render,
      },
      bucket,
      now: () => new Date("2026-09-19T20:00:00.000Z"),
    });

    expect(bucket.readManifest().routes).toEqual([
      { kind: "live_only", pathname: "/", reason: "unsupported_route" },
    ]);
    expect(prepare).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });
});

const identity = {
  siteId: "site-1",
  renderId: "1".repeat(64),
  artifactIdentity: "2".repeat(64),
  rendererReleaseId: "3".repeat(64),
  renderContextId: "4".repeat(64),
  artifactPrefix: "sites/site-1/versions/source-1",
  sourceManifestPath: "sites/site-1/versions/source-1/manifest.json",
  sourceArtifactVersion: "source-1",
  trustedRequestOrigin: "https://docs.example.com",
};

function createPageData(pathname: string): PublicDocsRouteDataV1 {
  const section = { slug: "docs", label: "Docs", default: true };
  return {
    type: "page",
    slug: pathname.slice(1),
    href: pathname,
    homeHref: pathname,
    canonicalUrl: `https://docs.example.com${pathname}`,
    site: { name: "Demo", url: "https://docs.example.com" },
    features: {
      branding: true,
      rightSidebar: true,
      feedbackEdit: false,
      tableOfContents: true,
      scrollToTop: true,
      ai: { chat: false, chatWithPage: false, floatingInput: false },
      copyPage: { markdown: true, rawText: true },
      apiPlayground: false,
      rawMarkdown: true,
      loadFromGithub: false,
    },
    sections: [section],
    visibleSections: [section],
    currentSection: section,
    sectionHomeHrefs: { docs: pathname },
    sectionNavigation: [{ title: "Page", href: pathname }],
    sectionRoutes: [{ title: "Page", href: pathname }],
    routeTitle: "Page",
    sectionHeading: null,
    previous: null,
    next: null,
    document: null,
    rawDoc: null,
    runtimeDocument: null,
  };
}

function createBucket() {
  const objects = new Map<string, Uint8Array>();
  const writes: string[] = [];
  return {
    writes,
    get: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      return bytes
        ? {
            etag: `etag-${key}`,
            size: bytes.byteLength,
            arrayBuffer: async () => bytes.slice().buffer,
          }
        : null;
    }),
    put: vi.fn(
      async (
        key: string,
        value: Uint8Array,
        options: {
          onlyIf: { etagDoesNotMatch?: string; etagMatches?: string };
        },
      ) => {
        if (options.onlyIf.etagDoesNotMatch === "*" && objects.has(key))
          return null;
        objects.set(key, value);
        writes.push(key);
        return { etag: `etag-${key}` };
      },
    ),
    readManifest: () => {
      const entry = [...objects.entries()].find(([key]) =>
        key.endsWith("manifest.json"),
      );
      if (!entry) throw new Error("Manifest was not written");
      return JSON.parse(new TextDecoder().decode(entry[1])) as {
        routes: unknown[];
      };
    },
  };
}
