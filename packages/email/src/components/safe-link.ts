const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

/** Only `https:` links, and `http:` links to localhost, may appear in an email. */
export function assertSafeLink(href: string): string {
  if (URL.canParse(href)) {
    const url = new URL(href);
    if (url.protocol === "https:" || isLocalHttp(url)) return url.href;
  }
  throw new Error(`An email link must use https: "${href}".`);
}

function isLocalHttp(url: URL): boolean {
  return url.protocol === "http:" && (LOCAL_HOSTNAMES.has(url.hostname) || url.hostname.endsWith(".localhost"));
}
