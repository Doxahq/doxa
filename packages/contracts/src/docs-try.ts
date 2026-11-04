/**
 * The contract of the API playground's "Try it" proxy.
 *
 * The docs page, the dispatcher and `doxa-try-proxy` share this file. It holds
 * no Zod schema, so the docs page can import it with no cost to its bundle.
 *
 * SECURITY REGRESSION GUARDRAIL (SEC-010): `DocsTryRequest` has no URL or host
 * field. The server reads the target from the owner's site settings, so page
 * content and readers can never pick where a request goes. `targetId` can only
 * stop a send. It is a hash, so nothing can use it to choose a target.
 */

export const DOCS_TRY_PATH = "/__doxa/try";
export const DOCS_TRY_CONFIG_PATH = "/__doxa/try/config";
/** A custom type forces a CORS preflight, and the route answers none. */
export const DOCS_TRY_CONTENT_TYPE = "application/vnd.doxa.try+json";
export const DOCS_TRY_PROBLEM_CONTENT_TYPE = "application/problem+json";
/** Present only when the target answered. Its absence means that Doxa refused. */
export const DOCS_TRY_RESULT_HEADER = "x-doxa-try-result";
/** The proxy and the panel both say this when the target differs from the page. */
export const DOCS_TRY_TARGET_CHANGED_TITLE =
  "This site changed its API address. Reload the page, then enter your key again.";

export const DOCS_TRY_LIMITS = {
  requestBytes: 2 * 1024 * 1024,
  responseBytes: 10 * 1024 * 1024,
  firstByteMs: 30_000,
  totalMs: 60_000,
  eventStreamTotalMs: 5 * 60_000,
  headerCount: 50,
  headerBytes: 16 * 1024,
  resultHeaderBytes: 64 * 1024,
} as const;

export const DOCS_TRY_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;
export type DocsTryMethod = (typeof DOCS_TRY_METHODS)[number];

export interface DocsTryRequest {
  v: 1;
  /** From the config answer. The proxy refuses the send if the target changed. */
  targetId: string;
  method: DocsTryMethod;
  /** Starts with `/`. Holds no query string and no host. */
  path: string;
  query: [string, string][];
  headers: [string, string][];
  /** Typed by the reader. Never the cookies of the docs site. */
  cookies: [string, string][];
  body?: { encoding: "utf8"; data: string };
}

/** Why the reader's browser sends the request, rather than the proxy. */
export type DocsTryBrowserReason =
  | "owner_choice"
  | "same_origin"
  | "private_site"
  | "proxy_off"
  | "target_not_allowed";

export type DocsTryConfig =
  | {
      mode: "proxy";
      targetHost: string;
      /** The panel compares this with the base URL that its page rendered with. */
      targetBaseUrl: string;
      /** The request sends this back, so the proxy can compare it at send time. */
      targetId: string;
      limits: { requestBytes: number; responseBytes: number; timeoutMs: number };
      preview?: boolean;
    }
  | { mode: "browser"; reason: DocsTryBrowserReason; preview?: boolean }
  | { mode: "off" };

export interface DocsTryResult {
  status: number;
  statusText: string;
  elapsedMs: number;
  headers: [string, string][];
  headersTruncated: boolean;
  redirect?: { location: string; sameTarget: boolean };
}

export type DocsTryProblemCode =
  | "try_off"
  | "not_same_origin"
  | "target_blocked"
  | "target_changed"
  | "invalid_request"
  | "unsupported_media_type"
  | "path_refused"
  | "header_refused"
  | "body_too_large"
  | "rate_limited"
  | "target_dns"
  | "target_tls"
  | "target_refused"
  | "target_timeout";

export interface DocsTryProblem {
  code: DocsTryProblemCode;
  title: string;
  retryAfter?: number;
}

/** What the dispatcher tells the proxy. The server made all of it. */
export interface DocsTryContext {
  siteId: string;
  baseUrl: string;
  /** The rate-limit key of the client, not a raw address. */
  clientKey: string;
}

export interface DocsTryProxyRpc {
  config(context: DocsTryContext): Promise<DocsTryConfig>;
  send(
    body: ReadableStream<Uint8Array> | null,
    context: DocsTryContext,
  ): Promise<Response>;
}

export type DocsTryTargetRefusal =
  | "relative"
  | "invalid"
  | "not_https"
  | "credentials"
  | "port"
  | "query"
  | "not_a_dns_name"
  | "ip_literal"
  | "local_name"
  | "reserved_zone";

export type DocsTryTarget =
  | { ok: true; origin: string; host: string; basePath: string }
  | { ok: false; reason: DocsTryTargetRefusal };

const LOCAL_HOST_SUFFIX =
  /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|test|invalid|onion)$/;
// The URL parser turns every IPv4 form (decimal, hex, short) into dotted form.
const IP_ADDRESS_HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/;

/**
 * The rules for a host that the proxy may send to. These are the only checks
 * on the host, because the owner does not prove control of it. Cloudflare
 * refuses a name that resolves to a private address (error 1016), and the
 * Worker has no route to any private network. A check here cannot replace that,
 * because Workers has no hook at connect time.
 */
export function parseDocsTryTarget(
  baseUrl: string,
  reservedZones: readonly string[],
): DocsTryTarget {
  if (baseUrl.startsWith("/")) return { ok: false, reason: "relative" };
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (url.username || url.password) return { ok: false, reason: "credentials" };
  if (url.port) return { ok: false, reason: "port" };
  if (url.search || url.hash) return { ok: false, reason: "query" };

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (IP_ADDRESS_HOST.test(host)) return { ok: false, reason: "ip_literal" };
  if (!host.includes(".")) return { ok: false, reason: "not_a_dns_name" };
  if (LOCAL_HOST_SUFFIX.test(host)) return { ok: false, reason: "local_name" };
  if (reservedZones.some((zone) => isHostInZone(host, zone))) {
    return { ok: false, reason: "reserved_zone" };
  }
  return {
    ok: true,
    origin: `https://${host}`,
    host,
    basePath: url.pathname.replace(/\/+$/, ""),
  };
}

/** The base URL of a target in its normal form, as the proxy sends to it. */
export function docsTryTargetBaseUrl(target: { origin: string; basePath: string }): string {
  return `${target.origin}${target.basePath}`;
}

/**
 * True when a proxy config applies to the base URL of the page. A page can stay
 * open while the owner changes the target, so its key can belong to another API.
 */
export function isDocsTryTargetOfPage(targetBaseUrl: string, pageBaseUrl: string): boolean {
  const page = parseDocsTryTarget(pageBaseUrl, []);
  return page.ok && docsTryTargetBaseUrl(page) === targetBaseUrl;
}

/** True when `host` is `zone` itself or a name under it. */
export function isHostInZone(host: string, zone: string): boolean {
  const normalized = zone.trim().toLowerCase().replace(/\.$/, "");
  return Boolean(normalized) && (host === normalized || host.endsWith(`.${normalized}`));
}

const BASE64URL_PADDING = /=+$/;

export function encodeDocsTryResult(result: DocsTryResult): string {
  const bytes = new TextEncoder().encode(JSON.stringify(result));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(BASE64URL_PADDING, "");
}

/** Null when the value is not a result. The panel then treats it as no answer. */
export function decodeDocsTryResult(value: string): DocsTryResult | null {
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(parsed) || typeof parsed.status !== "number") return null;
    return parsed as unknown as DocsTryResult;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
