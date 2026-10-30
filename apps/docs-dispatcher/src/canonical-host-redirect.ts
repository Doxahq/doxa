import type { DocsDomainResolution } from "@doxahq/contracts";

import {
  isCertificateValidationPath,
  REDIRECT_CACHE_CONTROL,
} from "./https-policy";

/**
 * Permanent redirect from a site's `doxa.page` hostname to its custom domain.
 *
 * The resolver sets `canonicalHostname` only on the production `doxa.page`
 * resolution of a site whose custom domain works, so a site with a custom
 * domain has one public address. Every request redirects, with its path and
 * query, except the certificate validation paths.
 */

/** About one redirect in a hundred writes `docs_canonical_host_redirect`. */
export const CANONICAL_HOST_REDIRECT_LOG_SAMPLE_RATE = 0.01;

export function createCanonicalHostRedirect(
  request: Request,
  resolution: DocsDomainResolution | null,
  options: { random?: () => number } = {},
): Response | null {
  const target = readCanonicalHostname(resolution);
  if (!target) return null;
  const url = new URL(request.url);
  if (url.hostname === target || isCertificateValidationPath(url.pathname)) {
    return null;
  }
  url.protocol = "https:";
  url.hostname = target;
  url.port = "";
  url.hash = "";
  // 308 keeps the method and the body of anything but a read.
  const status =
    request.method === "GET" || request.method === "HEAD" ? 301 : 308;
  logCanonicalHostRedirect(request, target, status, options.random ?? Math.random);
  return new Response(null, {
    status,
    headers: { location: url.href, "cache-control": REDIRECT_CACHE_CONTROL },
  });
}

function readCanonicalHostname(
  resolution: DocsDomainResolution | null,
): string | null {
  if (
    resolution?.domainKind !== "doxa_subdomain" ||
    resolution.renderTarget !== "production" ||
    !resolution.canonicalHostname
  ) {
    return null;
  }
  return isBareHostname(resolution.canonicalHostname)
    ? resolution.canonicalHostname
    : null;
}

/** A hostname alone: no scheme, port, path or user part can ride along. */
function isBareHostname(value: string): boolean {
  try {
    return new URL(`https://${value}`).hostname === value;
  } catch {
    return false;
  }
}

function logCanonicalHostRedirect(
  request: Request,
  target: string,
  status: number,
  random: () => number,
): void {
  if (random() >= CANONICAL_HOST_REDIRECT_LOG_SAMPLE_RATE) return;
  console.info(
    JSON.stringify({
      event: "docs_canonical_host_redirect",
      hostname: new URL(request.url).hostname,
      target,
      method: request.method,
      status,
      sampleRate: CANONICAL_HOST_REDIRECT_LOG_SAMPLE_RATE,
    }),
  );
}
