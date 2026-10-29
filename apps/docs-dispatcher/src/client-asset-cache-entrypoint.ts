import { WorkerEntrypoint } from "cloudflare:workers";

import { withoutResponseCaching } from "./cache-policy";
import {
  CLIENT_ASSET_CACHE_FORMAT,
  clientAssetContentType,
  createClientAssetCacheUrl,
  isClientAssetFileName,
  type ClientAssetCacheProps,
} from "./client-asset-fallback";

interface ClientAssetCacheEnv {
  RENDERER_CODE_BUCKET: R2Bucket;
}

/**
 * The fixed key prefix of uploaded client assets. The file name has no slash,
 * so a key can never reach `renderer-code/` or any other prefix.
 */
export const CLIENT_ASSET_KEY_PREFIX = "client-assets/v1/assets/";

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const MISS_CACHE_CONTROL = "public, max-age=60";

export function clientAssetObjectKey(file: string): string {
  return `${CLIENT_ASSET_KEY_PREFIX}${file}`;
}

/**
 * Cache entrypoint for old client assets. A file name names one immutable
 * build output, so a hit is stored for a year. A miss is stored for a minute,
 * so an unknown name cannot send every request to R2.
 */
export class DocsClientAssetCache extends WorkerEntrypoint<
  ClientAssetCacheEnv,
  ClientAssetCacheProps
> {
  async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props;
    if (!isTrustedClientAssetRequest(request, props)) {
      return withoutResponseCaching(
        new Response("Invalid client asset cache request", { status: 400 }),
      );
    }
    const object = await this.env.RENDERER_CODE_BUCKET.get(
      clientAssetObjectKey(props.file),
    );
    if (!object) return createClientAssetMissResponse();
    return createClientAssetResponse(props.file, object.body);
  }
}

/** Only a valid file name, at its one internal URL, is read. */
export function isTrustedClientAssetRequest(
  request: Request,
  props: ClientAssetCacheProps,
): boolean {
  return (
    request.method === "GET" &&
    props.format === CLIENT_ASSET_CACHE_FORMAT &&
    isClientAssetFileName(props.file) &&
    request.url === createClientAssetCacheUrl(props.file)
  );
}

/**
 * Headers come only from this allowlist. R2 `httpMetadata` is never copied,
 * so an uploaded object cannot set its own content type or other headers.
 */
export function createClientAssetResponse(
  file: string,
  body: ReadableStream,
): Response {
  const contentType = clientAssetContentType(file);
  if (!contentType) throw new Error("Not a client asset file name.");
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "x-content-type-options": "nosniff",
      "cache-control": IMMUTABLE_CACHE_CONTROL,
    },
  });
}

export function createClientAssetMissResponse(): Response {
  return new Response(null, {
    status: 404,
    headers: { "cache-control": MISS_CACHE_CONTROL },
  });
}
