import type { DocsDomainResolution } from "@doxahq/contracts";
import { WorkerEntrypoint } from "cloudflare:workers";

import {
  attachInternalServerTiming,
  createServerTiming,
  type ServerTimingRecorder,
} from "./server-timing";
import {
  createCanonicalTextRequest,
  createTextCacheProps,
  isTrustedDocsTextCacheRequest,
  withDocsTextCachePolicy,
  type DocsTextRoute,
  type TextCacheProps,
} from "./text-cache-policy";
import { serveVersionedEntrypoint } from "./versioned-entrypoint-protocol";
import type { CacheEntrypoint } from "./worker-exports";

export interface DocsTextCacheEnv {
  DEBUG?: string;
  DOXA_RENDERER_BUILD_ID?: string;
}

/** One canonical text request, pinned to the site's resolved version. */
export interface DocsTextRenderInput {
  request: Request;
  resolution: DocsDomainResolution;
  timing: ServerTimingRecorder;
}

/**
 * The `DocsTextCache` entrypoint without its renderer. The dispatcher extends
 * it with its own renderer call, so this module does not depend on the
 * dispatcher's environment.
 */
export abstract class DocsTextCacheEntrypoint<
  Env extends DocsTextCacheEnv,
> extends WorkerEntrypoint<Env, TextCacheProps> {
  protected abstract render(input: DocsTextRenderInput): Promise<Response>;

  async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props;
    // Text routes have no previous-build fallback, so no previous build.
    return serveVersionedEntrypoint({
      entrypoint: "DocsTextCache",
      request,
      props,
      build: {
        requested: props.rendererBuildId,
        deployed: this.env.DOXA_RENDERER_BUILD_ID?.trim() || null,
        previous: null,
      },
      isTrusted: () => isTrustedDocsTextCacheRequest(request, props),
      rejection: "Invalid text cache request",
      fill: async () => {
        const timing = createServerTiming(this.env.DEBUG);
        const rendered = await this.render({
          request,
          resolution: props.resolution,
          timing,
        });
        return attachInternalServerTiming(
          withDocsTextCachePolicy(rendered, props.route),
          timing,
        );
      },
    });
  }
}

export interface DocsTextCacheRequest {
  /** The visitor request, `GET` or `HEAD`. */
  request: Request;
  resolution: DocsDomainResolution;
  route: DocsTextRoute;
  rendererBuildId: string;
  deliveryRenderId: string | null;
  cache: CacheEntrypoint<TextCacheProps>;
}

/**
 * Serves a text route from `DocsTextCache`. The cache always sees the same
 * canonical `GET`; a visitor `HEAD` gets the stored response without a body.
 */
export async function fetchDocsTextFromCache(
  input: DocsTextCacheRequest,
): Promise<Response> {
  const props = createTextCacheProps(input.request, input.resolution, {
    rendererBuildId: input.rendererBuildId,
    deliveryRenderId: input.deliveryRenderId,
    route: input.route,
  });
  const cached = await input
    .cache({ props })
    .fetch(createCanonicalTextRequest(input.request));
  const cacheStatus = cached.headers.get("cf-cache-status") ?? "UNAVAILABLE";
  logDocsTextCache({
    hostname: props.hostname,
    siteId: input.resolution.siteId,
    route: input.route,
    status: cached.status,
    cacheStatus,
  });
  const headers = new Headers(cached.headers);
  headers.set("x-doxa-text-cache", cacheStatus);
  const isHead = input.request.method === "HEAD";
  if (isHead) await cached.body?.cancel();
  return new Response(isHead ? null : cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers,
  });
}

function logDocsTextCache(fields: {
  hostname: string;
  siteId: string;
  route: DocsTextRoute;
  status: number;
  cacheStatus: string;
}): void {
  console.info(JSON.stringify({ event: "docs_text_cache", ...fields }));
}
