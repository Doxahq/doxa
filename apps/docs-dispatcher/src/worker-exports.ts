import type { DocsHostResolution } from "@doxahq/contracts";
import type { PublicDocsRouteDataV1 } from "@doxahq/contracts/docs-prerender";

import type { HostCacheProps, HtmlCacheProps } from "./cache-policy";
import type { PrerenderCacheProps } from "./prerender-cache-entrypoint";
import type { RendererCodeCacheProps } from "./renderer-code-readers";
import type { RouteDataCacheProps } from "./route-data-cache-entrypoint";

export interface RuntimeRequest {
  operation: string;
  payload?: unknown;
  resolution?: unknown;
}

export type RuntimeResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };

export interface DocsRuntimeRpc {
  asset?(input: {
    resolution: DocsHostResolution;
    hash: string;
  }): Promise<Response>;
  versionAsset?(input: {
    resolution: DocsHostResolution;
    name: string;
    /** The content hash from `?v=`. An older runtime ignores it. */
    version?: string | null;
  }): Promise<Response>;
  request(input: {
    resolution: DocsHostResolution;
    operation: string;
    payload?: unknown;
  }): Promise<RuntimeResponse>;
}

export interface ScopedDocsContentProps {
  resolution: DocsHostResolution;
}

export interface PrerenderRendererRpc {
  getPlan(input: { resolution: DocsHostResolution }): Promise<unknown>;
  prepare(input: {
    resolution: DocsHostResolution;
    pathname: string;
  }): Promise<PublicDocsRouteDataV1>;
  render(input: {
    resolution: DocsHostResolution;
    pathname: string;
    requestUrl: string;
    renderId: string;
    routeData: PublicDocsRouteDataV1;
  }): Promise<Response>;
}

export type CacheEntrypoint<Props> = (options: {
  props: Props;
}) => Pick<Fetcher, "fetch">;

/** Loopback bindings to this Worker's own named entrypoints. */
export interface DispatcherExports {
  ScopedDocsContent(options: { props: ScopedDocsContentProps }): DocsRuntimeRpc;
  DocsHostCache: CacheEntrypoint<HostCacheProps>;
  DocsHtmlCache: CacheEntrypoint<HtmlCacheProps>;
  DocsPrerenderCache: CacheEntrypoint<PrerenderCacheProps>;
  DocsRouteDataCache: CacheEntrypoint<RouteDataCacheProps>;
  DocsRendererCodeCache: CacheEntrypoint<RendererCodeCacheProps>;
  PrerenderRendererApi(options: {
    props?: Record<string, never>;
  }): PrerenderRendererRpc;
}

export function getWorkerExports(ctx: ExecutionContext): DispatcherExports {
  // The installed workers-types predates typed ctx.exports. This is the only
  // place that reads it.
  return (ctx as unknown as { exports: DispatcherExports }).exports;
}
