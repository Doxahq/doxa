import {
  parsePublicDocsRouteDataV1,
  type PublicDocsRouteDataV1,
} from "@doxahq/contracts/docs-prerender";
import type { RuntimeMdxParseOptions } from "@doxahq/mdx-runtime";

import {
  resolveDocsRootRouteData,
  resolveDocsRouteData,
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
  const highlighter = options.highlighter ?? (await loadDocsHighlighter());
  const data =
    pathname === "/"
      ? await resolveDocsRootRouteData(source, {
          includeRawDocument: false,
          includeRuntimeDocument: true,
          highlighter,
        })
      : await resolveDocsRouteData(source, pathname, {
          includeRawDocument: false,
          includeRuntimeDocument: true,
          highlighter,
        });

  if (
    (data.type === "page" || data.type === "not_found") &&
    data.runtimeDocument?.ok === false
  ) {
    throw new Error("A route with an MDX parse failure cannot be saved.");
  }

  return parsePublicDocsRouteDataV1(data);
}

async function loadDocsHighlighter(): Promise<
  RuntimeMdxParseOptions["highlighter"]
> {
  const { getDocsHighlighter } = await import("@doxahq/mdx-runtime/highlight");
  return getDocsHighlighter();
}
