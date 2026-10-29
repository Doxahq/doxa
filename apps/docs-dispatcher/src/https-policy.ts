/**
 * HTTP → HTTPS redirect for docs hostnames (M23).
 *
 * `DOXA_PROD_HTTPS_REDIRECT_MODE` is `off` or `on`. With `on`, the dispatcher
 * redirects every plain-HTTP request to the same URL over HTTPS, and adds HSTS
 * to every HTTPS response (`withDocsStrictTransportSecurity`). The target host
 * is the request host, so the redirect cannot point to another site.
 *
 * Certificate validation must work over plain HTTP, so its paths never
 * redirect. Static files that Workers Assets serves never run the Worker:
 * they get no redirect and no HSTS from here.
 */
export type HttpsRedirectMode = "off" | "on";

export interface HttpsPolicyEnv {
  DOXA_PROD_HTTPS_REDIRECT_MODE?: string;
}

/** Paths that a certificate authority or Cloudflare reads over plain HTTP. */
const CERTIFICATE_VALIDATION_PATH_PREFIXES = [
  "/.well-known/acme-challenge/",
  "/.well-known/cf-custom-hostname-challenge/",
] as const;

/** A browser keeps a 301 a long time; shared caches keep it one hour. */
const REDIRECT_CACHE_CONTROL = "public, max-age=3600";

/** About one redirect in a hundred writes `docs_https_redirect`. */
export const HTTPS_REDIRECT_LOG_SAMPLE_RATE = 0.01;

export function parseHttpsRedirectMode(
  value: string | undefined,
  warn: (message: string) => void = console.warn,
): HttpsRedirectMode {
  if (value === "on") return "on";
  if (value !== undefined && value !== "off") {
    warn(
      `[doxa-docs-dispatcher] Invalid DOXA_PROD_HTTPS_REDIRECT_MODE ${JSON.stringify(value)}; HTTP requests are not redirected.`,
    );
  }
  return "off";
}

export function isCertificateValidationPath(pathname: string): boolean {
  return CERTIFICATE_VALIDATION_PATH_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix),
  );
}

/**
 * Returns the redirect for a plain-HTTP request, or null when the request
 * must continue: HTTPS already, or a certificate validation path.
 * `GET`/`HEAD` get 301; every other method gets 308, which keeps the method
 * and the body.
 */
export function createHttpsRedirect(
  request: Request,
  options: { random?: () => number } = {},
): Response | null {
  const url = new URL(request.url);
  if (url.protocol !== "http:" || isCertificateValidationPath(url.pathname)) {
    return null;
  }
  url.protocol = "https:";
  // An explicit HTTP port has no HTTPS meaning; the default HTTPS port is used.
  url.port = "";
  const status =
    request.method === "GET" || request.method === "HEAD" ? 301 : 308;
  logHttpsRedirect(request, status, options.random ?? Math.random);
  return new Response(null, {
    status,
    headers: {
      location: url.href,
      "cache-control": REDIRECT_CACHE_CONTROL,
    },
  });
}

function logHttpsRedirect(
  request: Request,
  status: number,
  random: () => number,
): void {
  if (random() >= HTTPS_REDIRECT_LOG_SAMPLE_RATE) return;
  console.info(
    JSON.stringify({
      event: "docs_https_redirect",
      hostname: new URL(request.url).hostname,
      method: request.method,
      status,
      sampleRate: HTTPS_REDIRECT_LOG_SAMPLE_RATE,
    }),
  );
}
