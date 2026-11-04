import { DOCS_TRY_LIMITS, type DocsTryRequest } from "@doxahq/contracts/docs-try";

/** Identifies the traffic, so that a customer can recognize and block it. */
export const TRY_USER_AGENT = "DoxaTryIt/1 (+https://doxa.so/try-it)";
/** Names the docs site, so that the owner of the target can report it. */
export const TRY_SITE_HEADER = "x-doxa-try-site";

const CONTROL_OR_SEPARATOR = /[\\?#\u0000-\u001f\u007f]/;
const ENCODED_SEPARATOR = /%(?:2e|2f|5c)/gi;
const DOUBLE_ENCODED_SEPARATOR = /%25(?:2e|2f|5c)/i;

function decodeSeparator(match: string): string {
  return match.toLowerCase() === "%2e" ? "." : "/";
}

/**
 * The URL to send to, or null when the path is refused. The path comes from
 * the page and the reader, so it must never leave the owner's base URL.
 * `%2F` stays allowed, because some APIs use it in IDs.
 */
export function buildTargetUrl(
  target: { origin: string; basePath: string },
  request: Pick<DocsTryRequest, "path" | "query">,
): URL | null {
  const { path } = request;
  if (!path.startsWith("/") || path.includes("//")) return null;
  if (CONTROL_OR_SEPARATOR.test(path) || DOUBLE_ENCODED_SEPARATOR.test(path)) return null;
  const pieces = path.replace(ENCODED_SEPARATOR, decodeSeparator).split("/");
  if (pieces.some((piece) => piece === "." || piece === "..")) return null;

  let url: URL;
  try {
    url = new URL(`${target.origin}${target.basePath}${path}`);
  } catch {
    return null;
  }
  // The check runs on the built URL, because the parser has the last word.
  if (url.origin !== target.origin) return null;
  if (target.basePath && !`${url.pathname}/`.startsWith(`${target.basePath}/`)) return null;

  for (const [name, value] of request.query) url.searchParams.append(name, value);
  return url;
}

const DENIED_HEADERS = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "forwarded",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "true-client-ip",
  "upgrade",
  "user-agent",
  "via",
  "x-real-ip",
]);
const DENIED_HEADER_PREFIXES = ["cf-", "proxy-", "sec-", "x-doxa-", "x-forwarded-"];
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[^\u0000\r\n]*$/;
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const COOKIE_VALUE = /^[^\u0000-\u001f\u007f;]*$/;

export type BuildTargetHeadersResult =
  | { ok: true; headers: Headers }
  | { ok: false; name: string };

/**
 * Starts from empty headers and never copies from the inbound request, so a
 * reader's docs cookies and IP address cannot reach the target.
 */
export function buildTargetHeaders(
  request: Pick<DocsTryRequest, "headers" | "cookies">,
  siteId: string,
): BuildTargetHeadersResult {
  const headers = new Headers();
  let bytes = 0;
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (
      !HEADER_NAME.test(name) ||
      !HEADER_VALUE.test(value) ||
      DENIED_HEADERS.has(lower) ||
      DENIED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
    ) {
      return { ok: false, name };
    }
    bytes += name.length + value.length;
    headers.append(name, value);
  }

  const cookies: string[] = [];
  for (const [name, value] of request.cookies) {
    if (!COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value)) {
      return { ok: false, name: "cookie" };
    }
    bytes += name.length + value.length;
    cookies.push(`${name}=${value}`);
  }
  if (bytes > DOCS_TRY_LIMITS.headerBytes) return { ok: false, name: "total size" };
  if (cookies.length > 0) {
    const existing = headers.get("cookie");
    headers.set("cookie", [...(existing ? [existing] : []), ...cookies].join("; "));
  }

  headers.set("user-agent", TRY_USER_AGENT);
  headers.set(TRY_SITE_HEADER, siteId);
  return { ok: true, headers };
}
