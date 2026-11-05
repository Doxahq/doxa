import type { DocsDomainResolution } from "@doxahq/contracts";
import {
  DOCS_SEARCH_CONFIG_PATH,
  DOCS_SEARCH_GATEWAY_PATH,
  DOCS_SEARCH_INDEX_PATH,
  DOCS_SEARCH_SNIPPETS_PATH,
  MAX_BROWSER_SEARCH_INDEX_BYTES,
  createBrowserSearchConfig,
  type DocsSearchClientConfig,
} from "@doxahq/contracts/docs-search";

import { splitCompiledSearchIndex } from "@doxahq/docs-search/browser-artifacts";

import { isPublicProduction } from "./cache-policy";
import { requestDocsRuntime } from "./runtime-trace";
import type { DocsRuntimeRpc } from "./worker-exports";

const CONFIG_BROWSER_TTL_SECONDS = 60;
const INDEX_EDGE_TTL_SECONDS = 30 * 24 * 60 * 60;
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
/** Increase when the split files change shape. */
const DOCS_SEARCH_FILE_FORMAT = 1;

export function isDocsSearchRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return (
    pathname === DOCS_SEARCH_CONFIG_PATH ||
    pathname === DOCS_SEARCH_INDEX_PATH ||
    pathname === DOCS_SEARCH_SNIPPETS_PATH
  );
}

export interface DocsSearchRouteDependencies {
  resolveHost(hostname: string): Promise<DocsDomainResolution | null>;
  runtime: Pick<DocsRuntimeRpc, "request">;
  mode: string | undefined;
  gatewayOrigin: string | undefined;
  usage: AnalyticsEngineDataset | undefined;
  cache: Pick<Cache, "match" | "put">;
  waitUntil(work: Promise<unknown>): void;
}

/**
 * The same-origin side of docs search.
 *
 * SECURITY: every read uses the prefix of the resolved site. A request can name
 * no site, prefix or path, and `?v=` must name the live version. A site
 * behind an access gate gets the `server` mode, because the renderer runs the
 * gate. These routes answer no search files for it.
 */
export async function handleDocsSearchRequest(
  request: Request,
  deps: DocsSearchRouteDependencies,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "no-store" },
    });
  }
  const url = new URL(request.url);
  const resolution = await deps.resolveHost(url.hostname);

  if (url.pathname === DOCS_SEARCH_CONFIG_PATH) {
    return configResponse(createSearchConfig(resolution, deps));
  }
  if (
    deps.mode !== "on" ||
    !resolution ||
    resolution.accessPolicy !== "public"
  ) {
    return notFound();
  }
  return serveSearchFile(request, url, resolution, deps);
}

export function createSearchConfig(
  resolution: DocsDomainResolution | null,
  deps: Pick<DocsSearchRouteDependencies, "mode" | "gatewayOrigin">,
): DocsSearchClientConfig {
  if (
    deps.mode !== "on" ||
    !resolution ||
    resolution.accessPolicy !== "public"
  ) {
    return { mode: "server" };
  }
  if (
    resolution.searchProvider &&
    resolution.searchIndexKey &&
    isPublicProduction(resolution) &&
    deps.gatewayOrigin
  ) {
    return {
      mode: "gateway",
      endpoint: `${deps.gatewayOrigin}${DOCS_SEARCH_GATEWAY_PATH}`,
    };
  }
  return createBrowserSearchConfig(resolution.publishedVersionId);
}

async function serveSearchFile(
  request: Request,
  url: URL,
  resolution: DocsDomainResolution,
  deps: DocsSearchRouteDependencies,
): Promise<Response> {
  // The index and the snippets of one engine must come from one version. A
  // publish between the two downloads answers 409, and the page asks for the
  // config again.
  if (url.searchParams.get("v") !== resolution.publishedVersionId) {
    return new Response(null, {
      status: 409,
      headers: { "cache-control": "no-store" },
    });
  }
  const isIndex = url.pathname === DOCS_SEARCH_INDEX_PATH;
  const body = await readSearchFile(resolution, isIndex, deps);
  if (body === null) return notFound();

  const bytes = new TextEncoder().encode(body).length;
  if (bytes > MAX_BROWSER_SEARCH_INDEX_BYTES) {
    return new Response(null, {
      status: 413,
      headers: { "cache-control": IMMUTABLE_CACHE_CONTROL },
    });
  }
  if (isIndex) recordDownload(deps.usage, resolution, bytes);

  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "content-type": JSON_CONTENT_TYPE,
      "cache-control": IMMUTABLE_CACHE_CONTROL,
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * The edge cache holds both files per version, under a key made from the
 * resolved site and version. A miss splits the version's compiled index once.
 */
async function readSearchFile(
  resolution: DocsDomainResolution,
  isIndex: boolean,
  deps: Pick<DocsSearchRouteDependencies, "cache" | "runtime" | "waitUntil">,
): Promise<string | null> {
  const key = (file: "index" | "snippets") =>
    new Request(
      `https://docs-search.internal/${DOCS_SEARCH_FILE_FORMAT}/${resolution.siteId}/${resolution.publishedVersionId}/${file}`,
    );
  const cached = await deps.cache.match(key(isIndex ? "index" : "snippets"));
  if (cached) return cached.text();

  const answer = await requestDocsRuntime(
    deps.runtime,
    { resolution, operation: "getCompiledSearchIndex" },
    "search",
  );
  if (!answer.ok || typeof answer.data !== "string") return null;
  const files = splitCompiledSearchIndex(answer.data);
  if (!files) return null;

  const store = (file: "index" | "snippets", body: string) =>
    deps.cache.put(
      key(file),
      new Response(body, {
        headers: {
          "content-type": JSON_CONTENT_TYPE,
          "cache-control": `public, max-age=${INDEX_EDGE_TTL_SECONDS}`,
        },
      }),
    );
  deps.waitUntil(
    Promise.all([store("index", files.index), store("snippets", files.snippets)]),
  );
  return isIndex ? files.index : files.snippets;
}

function recordDownload(
  dataset: AnalyticsEngineDataset | undefined,
  resolution: DocsDomainResolution,
  bytes: number,
): void {
  try {
    dataset?.writeDataPoint({
      indexes: [resolution.siteId],
      blobs: [resolution.siteId, "minisearch", "index_download"],
      doubles: [0, bytes],
    });
  } catch {
    // A metric must never fail a download.
  }
}

function configResponse(config: DocsSearchClientConfig): Response {
  return new Response(JSON.stringify(config), {
    headers: {
      "content-type": JSON_CONTENT_TYPE,
      "cache-control": `private, max-age=${CONFIG_BROWSER_TTL_SECONDS}`,
    },
  });
}

function notFound(): Response {
  return new Response(null, {
    status: 404,
    headers: { "cache-control": "no-store" },
  });
}
