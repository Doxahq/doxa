import {
  CLIENT_COUNTRY_HEADER,
  CLIENT_IP_HEADER,
  CLIENT_REGION_HEADER,
  EDGE_ONLY_HEADERS,
  ORIGIN_KEY_HEADER,
  PUBLIC_URL_HEADER,
} from "@doxahq/api-bridge";
import { warmPoolForLocation } from "@doxahq/contracts/docs-warm-region";
import type { EdgeEnv } from "./env";
import { resolveOrigin } from "./origin";

/**
 * The largest request body that the edge forwards. It is above the largest
 * body that an API route accepts (content edits, about 58 MB). Each route
 * also bounds its own body at the origin.
 */
export const EDGE_MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * Sends a public request to the origin with the same method, path, query,
 * headers and body, and returns the origin's response as it is.
 *
 * The edge sets the origin key, the public URL and the client IP, country
 * and cache pool (region). A client cannot set them: the edge drops these
 * headers first.
 */
export async function proxyToOrigin(request: Request, env: EdgeEnv): Promise<Response> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && !(Number(declaredLength) <= EDGE_MAX_BODY_BYTES)) {
    return new Response("Request body is too large.", { status: 413 });
  }

  const origin = resolveOrigin(env);
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  for (const name of EDGE_ONLY_HEADERS) headers.delete(name);
  // The origin URL decides the Host header, not the client.
  headers.delete("host");

  headers.set(ORIGIN_KEY_HEADER, env.ORIGIN_SHARED_SECRET);
  headers.set(PUBLIC_URL_HEADER, request.url);
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) headers.set(CLIENT_IP_HEADER, clientIp);
  const country = request.cf?.country;
  if (typeof country === "string") headers.set(CLIENT_COUNTRY_HEADER, country);
  // The publisher's pool, warmed first after a publish (M45). Absent when unknown.
  const region = warmPoolForLocation(request.cf);
  if (region) headers.set(CLIENT_REGION_HEADER, region);

  // Built from the original request, so the method and the streamed body carry over.
  const forwarded = new Request(origin.url(url.pathname, url.search), request);
  // A chunked body has no length to check, so its stream stops at the limit.
  const body =
    declaredLength === null && request.body
      ? request.body.pipeThrough(byteLimit(EDGE_MAX_BODY_BYTES))
      : undefined;
  // Redirects go back to the client, which follows them on api.doxa.so.
  return origin.fetch(
    new Request(forwarded, {
      headers,
      redirect: "manual",
      // Node's fetch needs `duplex` for a stream body; workerd accepts it.
      ...(body ? ({ body, duplex: "half" } as RequestInit) : {}),
    }),
  );
}

/** Passes bytes through, and errors the stream after `maxBytes`. */
function byteLimit(maxBytes: number): TransformStream<Uint8Array, Uint8Array> {
  let size = 0;
  return new TransformStream({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        controller.error(new Error("Request body is too large."));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}
