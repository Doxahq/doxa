import type { DocsDomainResolution } from "@doxahq/contracts";
import { vi } from "vitest";

import { DocsHostCache, DocsHtmlCache, DocsRouteDataCache } from "../../src/index";
import { DocsPrerenderCache } from "../../src/prerender-cache-entrypoint";
import type { PublicCacheCall } from "../../src/public-cache-calls";
import { CACHE_PROBE_HEADER } from "../../src/versioned-entrypoint-protocol";
import { createRouteData } from "./route-data";

/**
 * A dispatcher with a fake Workers Cache in front of its cache entrypoints:
 * an entry is keyed by entrypoint, props and canonical request, a stored
 * entry answers every call (probe or not) with HIT, and a miss reaches the
 * real entrypoint class. Mock `cloudflare:workers` in the test file first.
 */

export const BUILD = "b".repeat(64);
export const RELEASE = "c".repeat(64);
export const PREVIOUS_BUILD = "1".repeat(64);
export const PREVIOUS_RELEASE = "2".repeat(64);

export const resolution: DocsDomainResolution = {
  siteId: "site-1",
  projectId: "project-1",
  projectSlug: "demo",
  publishedVersionId: "version-1",
  artifactPrefix: "sites/site-1/versions/source-1",
  manifestPath: "sites/site-1/versions/source-1/manifest.json",
  accessPolicy: "public",
  hostname: "docs.example.com",
  domainKind: "custom_domain",
  renderTarget: "production",
};

export interface CacheCallRecord {
  entrypoint: string;
  props: unknown;
  url: string;
  method: string;
  headers: Record<string, string>;
  probe: boolean;
  status: "HIT" | "MISS";
}

interface StoredEntry {
  status: number;
  headers: [string, string][];
  body: string;
}

export function createSimulatedWorld(
  envOverrides: Record<string, string | undefined> = {},
) {
  const store = new Map<string, StoredEntry>();
  const calls: CacheCallRecord[] = [];
  const kv = new Map<string, string>();
  const backgroundTasks: Promise<unknown>[] = [];
  const render = vi.fn(
    async (_request: Request) =>
      new Response("<p>Live build</p>", {
        headers: { "content-type": "text/html" },
      }),
  );
  const prepare = vi.fn(async () => createRouteData());
  const bucket = { get: vi.fn(async (_key: string) => null) };
  const env: Record<string, unknown> = {
    DOCS_RESOLVER: { fetch: vi.fn(async () => Response.json({ resolution })) },
    SHARED_RENDERER: { fetch: vi.fn(async () => new Response("shared")) },
    LOADER: {
      get: vi.fn(() => ({ getEntrypoint: () => ({ fetch: render }) })),
    },
    DOCS_HOSTNAME_MAP: {
      get: vi.fn(async (key: string) => kv.get(key) ?? null),
    },
    DOCS_RENDERED_BUCKET: bucket,
    DOXA_PROD_DYNAMIC_RENDERER_MODE: "all",
    DOXA_RENDERER_BUILD_ID: BUILD,
    DOXA_RENDERER_RELEASE_ID: RELEASE,
    DOXA_RENDERER_PACKAGE_KEY: `renderer-code/${BUILD}.json.gz`,
    DOXA_PREVIOUS_RENDERER_BUILD_ID: PREVIOUS_BUILD,
    DOXA_PREVIOUS_RENDERER_RELEASE_ID: PREVIOUS_RELEASE,
    DOXA_RENDERER_DEPLOYED_AT: new Date(Date.now() - 3_600_000).toISOString(),
    DOXA_PROD_PREVIOUS_FALLBACK_MODE: "on",
    DOXA_PROD_WARM_MODE: "all",
    DOXA_PROD_ROUTE_DATA_CACHE_MODE: "all",
    DOXA_PROD_PRERENDER_MODE: "off",
    ...envOverrides,
  };

  const cached =
    <Props>(
      entrypoint: string,
      create: (props: Props) => { fetch(request: Request): Promise<Response> },
    ) =>
    ({ props }: { props: Props }) => ({
      fetch: async (request: Request): Promise<Response> => {
        const key = cacheKey(entrypoint, props, request);
        const probe = request.headers.get(CACHE_PROBE_HEADER) === "1";
        const hit = store.get(key);
        calls.push({
          entrypoint,
          props,
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(request.headers),
          probe,
          status: hit ? "HIT" : "MISS",
        });
        if (hit) return toResponse(hit, "HIT");
        const response = await create(props).fetch(request);
        const entry: StoredEntry = {
          status: response.status,
          headers: [...response.headers],
          body: await response.text(),
        };
        if (
          entry.status === 200 &&
          /^public\b/.test(response.headers.get("cache-control") ?? "")
        ) {
          store.set(key, entry);
        }
        return toResponse(entry, "MISS");
      },
    });

  const ctx = {
    waitUntil: vi.fn((task: Promise<unknown>) => {
      backgroundTasks.push(task);
    }),
    exports: {} as Record<string, unknown>,
  };
  const entrypointCtx = (props: unknown) => ({
    props,
    exports: ctx.exports,
    waitUntil: ctx.waitUntil,
  });
  Object.assign(ctx.exports, {
    DocsHostCache: ({ props }: { props: { hostname: string } }) =>
      new DocsHostCache({ props } as never, env as never),
    DocsHtmlCache: vi.fn(
      cached("DocsHtmlCache", (props) =>
        new DocsHtmlCache(entrypointCtx(props) as never, env as never),
      ),
    ),
    DocsRouteDataCache: vi.fn(
      cached("DocsRouteDataCache", (props) =>
        new DocsRouteDataCache(entrypointCtx(props) as never, env as never),
      ),
    ),
    DocsPrerenderCache: vi.fn(
      cached("DocsPrerenderCache", (props) =>
        new DocsPrerenderCache(entrypointCtx(props) as never, env as never),
      ),
    ),
    PrerenderRendererApi: () => ({ prepare }),
    ScopedDocsContent: vi.fn(() => ({ request: vi.fn() })),
  });

  return {
    env,
    ctx,
    calls,
    kv,
    render,
    prepare,
    bucket,
    backgroundTasks,
    /** Stores an entry as an earlier deploy would have. */
    seed(call: PublicCacheCall, body: string, contentType: string) {
      store.set(cacheKey(call.entrypoint, call.props, call.request), {
        status: 200,
        headers: [
          ["content-type", contentType],
          ["cache-control", "public, max-age=2592000"],
        ],
        body,
      });
    },
    has(call: PublicCacheCall) {
      return store.has(cacheKey(call.entrypoint, call.props, call.request));
    },
  };
}

export type SimulatedWorld = ReturnType<typeof createSimulatedWorld>;

/** A visitor request with `request.cf`, as Cloudflare delivers it. */
export function visitorRequest(
  url: string,
  init: RequestInit & { cf?: Record<string, unknown> } = {},
): Request {
  const { cf, ...rest } = init;
  const request = new Request(url, rest);
  Object.defineProperty(request, "cf", { value: cf ?? { colo: "CDG" } });
  return request;
}

function cacheKey(entrypoint: string, props: unknown, request: Request): string {
  return [entrypoint, stableJson(props), request.method, request.url].join("|");
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}

function toResponse(entry: StoredEntry, status: "HIT" | "MISS"): Response {
  const headers = new Headers(entry.headers);
  headers.set("cf-cache-status", status);
  return new Response(
    entry.status === 204 || entry.status === 304 ? null : entry.body,
    {
      status: entry.status,
      headers,
    },
  );
}
