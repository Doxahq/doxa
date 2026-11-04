import { WorkerEntrypoint } from "cloudflare:workers";

import { cacheControlFor, withoutResponseCaching } from "./cache-policy";
import {
  RENDERER_CODE_CACHE_FORMAT,
  createRendererCodeCacheUrl,
  type RendererCodeCacheProps,
} from "./renderer-code-readers";

interface RendererCodeCacheEnv {
  RENDERER_CODE_BUCKET: R2Bucket;
  DOXA_RENDERER_BUILD_ID?: string;
  DOXA_RENDERER_PACKAGE_KEY?: string;
}

/**
 * Cache entrypoint for the renderer code package. A package key names one
 * immutable build, so the gzip bytes are stored for a year. A new dispatcher
 * isolate then reads them from Workers Cache, in its own data center when
 * possible, instead of from the R2 bucket. The reader still checks the build
 * ID of every copy.
 */
export class DocsRendererCodeCache extends WorkerEntrypoint<
  RendererCodeCacheEnv,
  RendererCodeCacheProps
> {
  async fetch(request: Request): Promise<Response> {
    if (!isTrustedRendererCodeRequest(request, this.ctx.props, this.env)) {
      return withoutResponseCaching(
        new Response("Invalid renderer code cache request", { status: 400 }),
      );
    }
    const object = await this.env.RENDERER_CODE_BUCKET.get(
      this.ctx.props.objectKey,
    );
    if (!object) {
      return withoutResponseCaching(new Response(null, { status: 404 }));
    }
    return createRendererCodeResponse(object.body);
  }
}

/**
 * The opaque gzip bytes, exactly as stored. No `content-encoding`: the reader
 * decompresses them itself, as it does for an R2 body.
 */
export function createRendererCodeResponse(body: ReadableStream): Response {
  const cacheControl = cacheControlFor("versioned");
  return new Response(body, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": cacheControl,
      "cdn-cache-control": cacheControl,
      "cloudflare-cdn-cache-control": cacheControl,
    },
  });
}

/** Only the deployed build and key, at their one internal URL, are cached. */
export function isTrustedRendererCodeRequest(
  request: Request,
  props: RendererCodeCacheProps,
  env: Pick<
    RendererCodeCacheEnv,
    "DOXA_RENDERER_BUILD_ID" | "DOXA_RENDERER_PACKAGE_KEY"
  >,
): boolean {
  return (
    request.method === "GET" &&
    props.format === RENDERER_CODE_CACHE_FORMAT &&
    props.buildId === env.DOXA_RENDERER_BUILD_ID?.trim() &&
    props.objectKey === env.DOXA_RENDERER_PACKAGE_KEY?.trim() &&
    request.url === createRendererCodeCacheUrl(props.buildId)
  );
}
