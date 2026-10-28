import {
  parsePublicDocsRouteDataV1,
  type PublicDocsRouteDataV1,
} from "@doxahq/contracts/docs-prerender";
import type { RuntimeMdxParseOptions } from "@doxahq/mdx-runtime";

import {
  resolveDocsRootRouteData,
  resolveDocsRouteData,
  type DocsPageHighlighting,
  type ResolveDocsRouteDataOptions,
} from "./docs-route-data";
import type { DoxaDocsRuntimeSource } from "./runtime-source";

export interface PreparePublicDocsRouteOptions {
  highlighter?: RuntimeMdxParseOptions["highlighter"];
}

/**
 * Produces the one browser-safe DTO used by live loaders, saved route data,
 * and the TanStack HTML renderer. The source is expected to be pinned by the
 * caller; this layer never resolves a mutable hostname or version pointer.
 */
export async function preparePublicDocsRouteData(
  source: DoxaDocsRuntimeSource,
  pathname: string,
  options: PreparePublicDocsRouteOptions = {}
): Promise<PublicDocsRouteDataV1> {
  const resolveOptions: ResolveDocsRouteDataOptions = {
    includeRawDocument: false,
    includeRuntimeDocument: true,
    ...(options.highlighter
      ? { highlighter: options.highlighter }
      : { highlighting: await loadPageHighlighting() }),
  };
  const data =
    pathname === "/"
      ? await resolveDocsRootRouteData(source, resolveOptions)
      : await resolveDocsRouteData(source, pathname, resolveOptions);

  if (
    (data.type === "page" || data.type === "not_found") &&
    data.runtimeDocument?.ok === false
  ) {
    throw new Error("A route with an MDX parse failure cannot be saved.");
  }

  return parsePublicDocsRouteDataV1(data);
}

async function loadPageHighlighting(): Promise<DocsPageHighlighting> {
  const { loadServerPageHighlighting } = await import("./server-highlighter");
  return loadServerPageHighlighting();
}
