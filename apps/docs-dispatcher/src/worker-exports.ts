import type { DocsHostResolution } from "@doxahq/contracts";
import type { PublicDocsRouteDataV1 } from "@doxahq/contracts/docs-prerender";
import type { DocsRuntimeTrace } from "@doxahq/contracts/docs-runtime-trace";

import type { HostCacheProps, HtmlCacheProps } from "./cache-policy";
import type { ClientAssetCacheProps } from "./client-asset-fallback";
import type { PrerenderCacheProps } from "./prerender-cache-entrypoint";
import type { RendererCodeCacheProps } from "./renderer-code-readers";
import type { RouteDataCacheProps } from "./route-data-cache-entrypoint";
import type { TextCacheProps } from "./text-cache-policy";

export interface RuntimeRequest {
  operation: string;
  payload?: unknown;
  resolution?: unknown;
}

/**
 * `timing` is set only by a docs-runtime that received a `trace`. It crosses
 * a service boundary, so the dispatcher parses it before use
 * (`runtime-trace.ts`) and never passes it on to the renderer.
 */
export type RuntimeResponse = (
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } }
) & { timing?: unknown };

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
    /** Made by the dispatcher only. An older docs-runtime ignores it. */
    trace?: DocsRuntimeTrace;
  }): Promise<RuntimeResponse>;
}

export interface ScopedDocsContentProps {
  resolution: DocsHostResolution;
  /** Set by the dispatcher when it prefetched this render's route data. */
  routeDataPrefetchId?: string;
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
  DocsTextCache: CacheEntrypoint<TextCacheProps>;
  DocsClientAssetCache: CacheEntrypoint<ClientAssetCacheProps>;
  PrerenderRendererApi(options: {
    props?: Record<string, never>;
  }): PrerenderRendererRpc;
}

/** Request handlers pass their `ExecutionContext`; Durable Objects their state. */
export function getWorkerExports(
  ctx: ExecutionContext | DurableObjectState,
): DispatcherExports {
  // The installed workers-types predates typed ctx.exports. This is the only
  // place that reads it.
  return (ctx as unknown as { exports: DispatcherExports }).exports;
}
