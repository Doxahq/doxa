import { DOCS_HTML_SECURITY_HEADERS } from "./security-headers";
import type { PrerenderRouteLookup } from "./prerender-storage";

const HTML_RESPONSE_HEADERS = {
  ...DOCS_HTML_SECURITY_HEADERS,
  "content-type": "text/html; charset=utf-8",
  "x-doxa-representation-source": "prerender",
} as const;

export function createPrerenderHtmlResponse(
  lookup: PrerenderRouteLookup,
  method: string,
): Response | null {
  if (lookup.status !== "hit") return null;
  if (lookup.routeKind === "redirect") {
    if (!lookup.redirect) return null;
    return new Response(null, {
      status: lookup.redirect.status,
      headers: {
        ...HTML_RESPONSE_HEADERS,
        location: lookup.redirect.href,
      },
    });
  }
  if (!lookup.html) return null;

  return new Response(method === "HEAD" ? null : toArrayBuffer(lookup.html), {
    status: 200,
    headers: HTML_RESPONSE_HEADERS,
  });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
