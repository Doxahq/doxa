/**
 * Query parameters that may stay on a URL: campaign tags. Every other
 * parameter can hold a token (`?token=` on a reset link, an OAuth code), so
 * the scrubber drops it.
 */
const KEPT_QUERY_PARAMETERS: ReadonlySet<string> = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
]);

/** Routes whose next path segment is a secret or a one-time ID, with the name that replaces it. */
const SECRET_PATH_SEGMENTS: readonly { readonly prefix: string; readonly placeholder: string }[] = [
  { prefix: "/invite/", placeholder: ":token" },
  { prefix: "/approve/", placeholder: ":requestId" },
];

/** Properties that hold a page title. A dashboard title names projects and pages, so it never leaves. */
const TITLE_PROPERTIES: ReadonlySet<string> = new Set(["title", "$title"]);

/** Property names that hold a URL or a path, such as `$current_url`, `$referrer` and `$pathname`. */
const URL_PROPERTY = /url|referrer|pathname/i;

const PLACEHOLDER_ORIGIN = "https://placeholder.invalid";

/**
 * Removes secrets from a URL or a path: the fragment, every query parameter
 * except campaign tags, credentials, and secret path segments. A value that
 * is not a URL becomes an empty string.
 */
export function scrubAnalyticsUrl(value: string): string {
  const isAbsolute = /^[a-z][a-z\d+.-]*:/i.test(value);
  let url: URL;
  try {
    url = new URL(value, PLACEHOLDER_ORIGIN);
  } catch {
    return "";
  }
  url.hash = "";
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (!KEPT_QUERY_PARAMETERS.has(key)) url.searchParams.delete(key);
  }
  url.pathname = redactSecretSegments(url.pathname);
  return isAbsolute ? url.toString() : `${url.pathname}${url.search}`;
}

/**
 * Returns a copy of SDK properties with every URL scrubbed and page titles
 * removed. Other values stay as they are.
 */
export function scrubAnalyticsProperties(properties: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (TITLE_PROPERTIES.has(key)) continue;
    scrubbed[key] = typeof value === "string" && URL_PROPERTY.test(key) ? scrubAnalyticsUrl(value) : value;
  }
  return scrubbed;
}

function redactSecretSegments(pathname: string): string {
  for (const { prefix, placeholder } of SECRET_PATH_SEGMENTS) {
    if (!pathname.startsWith(prefix)) continue;
    const rest = pathname.slice(prefix.length);
    const slash = rest.indexOf("/");
    const tail = slash === -1 ? "" : rest.slice(slash);
    return rest === "" ? pathname : `${prefix}${placeholder}${tail}`;
  }
  return pathname;
}
