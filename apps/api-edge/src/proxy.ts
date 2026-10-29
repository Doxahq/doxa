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
 * Sends a public request to the origin with the same method, path, query,
 * headers and body, and returns the origin's response as it is.
 *
 * The edge sets the origin key, the public URL and the client IP, country
 * and cache pool (region). A client cannot set them: the edge drops these
 * headers first.
 */
export async function proxyToOrigin(request: Request, env: EdgeEnv): Promise<Response> {
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
  // Redirects go back to the client, which follows them on api.doxa.so.
  return origin.fetch(new Request(forwarded, { headers, redirect: "manual" }));
}
