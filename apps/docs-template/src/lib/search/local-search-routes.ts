import {
  DOCS_SEARCH_CONFIG_PATH,
  DOCS_SEARCH_INDEX_PATH,
  DOCS_SEARCH_SNIPPETS_PATH,
  MAX_BROWSER_SEARCH_INDEX_BYTES,
  createBrowserSearchConfig,
  type DocsSearchClientConfig,
} from "@doxahq/contracts/docs-search";
import { splitCompiledSearchIndex } from "@doxahq/docs-search/browser-artifacts";

import type { DoxaDocsRuntimeSource } from "@/src/runtime/runtime-source";

/**
 * Local stand-in for the dispatcher's search routes, because `pnpm dev` runs
 * no dispatcher. It uses the same split code and the same limit, so a local
 * site downloads the files that a published site downloads. Only `server.ts`
 * loads this module, and only under `import.meta.env.DEV`.
 */
const LOCAL_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  // A new local publish must show at once.
  "cache-control": "no-store",
} as const;

type LocalSearchSource = Pick<DoxaDocsRuntimeSource, "getCompiledSearchIndex">;

export function isLocalSearchRequest(pathname: string): boolean {
  return (
    pathname === DOCS_SEARCH_CONFIG_PATH ||
    pathname === DOCS_SEARCH_INDEX_PATH ||
    pathname === DOCS_SEARCH_SNIPPETS_PATH
  );
}

export async function localSearchResponse(
  request: Request,
  source: LocalSearchSource
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const { pathname } = new URL(request.url);
  const compiled = (await source.getCompiledSearchIndex?.()) ?? null;

  if (pathname === DOCS_SEARCH_CONFIG_PATH) {
    return Response.json(createLocalConfig(compiled), {
      headers: LOCAL_HEADERS,
    });
  }

  // The same rule as the dispatcher: both files must come from one version.
  const contentVersion = compiled ? readContentVersion(compiled) : null;
  if (
    contentVersion &&
    new URL(request.url).searchParams.get("v") !== contentVersion
  ) {
    return new Response(null, {
      status: 409,
      headers: { "cache-control": "no-store" },
    });
  }

  const files = compiled ? splitCompiledSearchIndex(compiled) : null;
  if (!files) return new Response(null, { status: 404 });
  const body = pathname === DOCS_SEARCH_INDEX_PATH ? files.index : files.snippets;
  if (new TextEncoder().encode(body).length > MAX_BROWSER_SEARCH_INDEX_BYTES) {
    return new Response(null, { status: 413 });
  }
  return new Response(request.method === "HEAD" ? null : body, {
    headers: LOCAL_HEADERS,
  });
}

function createLocalConfig(compiled: string | null): DocsSearchClientConfig {
  const contentVersion = compiled ? readContentVersion(compiled) : null;
  return contentVersion
    ? createBrowserSearchConfig(contentVersion)
    : { mode: "server" };
}

function readContentVersion(compiled: string): string | null {
  try {
    const value: unknown = JSON.parse(compiled);
    return value &&
      typeof value === "object" &&
      "contentVersion" in value &&
      typeof value.contentVersion === "string" &&
      value.contentVersion
      ? value.contentVersion
      : null;
  } catch {
    return null;
  }
}
