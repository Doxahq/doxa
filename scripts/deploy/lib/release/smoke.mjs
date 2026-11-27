// Smoke checks of production after a flip: the public entry points answer,
// and the API answers from this release's origin. A failed check after the
// flip rolls the release back (scripts/deploy/release.mjs).

import { RELEASE_HEADER } from "../../../../packages/api-bridge/src/protocol.ts";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * @typedef {object} SmokeCheck
 * @property {string} name
 * @property {string} url
 * @property {string} [contentType] the start of the expected content type
 * @property {string} [release] the release ID that the response must carry in RELEASE_HEADER
 *
 * @typedef {(input: string, init?: RequestInit) => Promise<Response>} FetchLike
 */

/**
 * The checks of a production release. The API check also proves that the
 * edge serves the new origin color: its response carries the release ID.
 *
 * @param {{ releaseId: string, originInRelease: boolean, extraUrls?: string[] }} options
 * @returns {SmokeCheck[]}
 */
export function productionSmokeChecks({ releaseId, originInRelease, extraUrls = [] }) {
  return [
    {
      name: "API (Postgres and Valkey)",
      url: "https://api.doxa.so/health/ready",
      contentType: "application/json",
      ...(originInRelease ? { release: releaseId } : {}),
    },
    { name: "MCP server", url: "https://mcp.doxa.so/health", contentType: "application/json" },
    { name: "Web app", url: "https://doxa.so/", contentType: "text/html" },
    ...extraUrls.map((url) => ({ name: url, url })),
  ];
}

/**
 * The URLs of DOXA_RELEASE_SMOKE_URLS (comma-separated), for example a docs page.
 *
 * @param {string | undefined} value
 * @returns {string[]}
 */
export function parseSmokeUrls(value) {
  const urls = (value ?? "").split(",").map((url) => url.trim()).filter(Boolean);
  for (const url of urls) {
    if (URL.parse(url)?.protocol !== "https:") throw new Error(`Smoke URL "${url}" must be an https URL.`);
  }
  return urls;
}

/**
 * Runs every check until it passes or runs out of attempts. Cloudflare needs
 * a few seconds to serve a new version everywhere, so a first failure is
 * retried.
 *
 * @param {SmokeCheck[]} checks
 * @param {{ fetchImpl?: FetchLike, attempts?: number, delayMs?: number, sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<string[]>} one line per failed check; empty when all passed
 */
export async function runSmokeChecks(checks, { fetchImpl = fetch, attempts = 6, delayMs = 10_000, sleep = defaultSleep } = {}) {
  const results = await Promise.all(
    checks.map(async (check) => {
      let failure = null;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        failure = await checkOnce(check, fetchImpl);
        if (failure === null) return null;
        if (attempt < attempts) await sleep(delayMs);
      }
      return `${check.name}: ${failure}`;
    }),
  );
  return results.filter((result) => result !== null);
}

/**
 * @param {SmokeCheck} check
 * @param {FetchLike} fetchImpl
 * @returns {Promise<string | null>} why the check failed, or null
 */
export async function checkOnce(check, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(check.url, { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    return `${check.url} did not answer (${error instanceof Error ? error.message : String(error)})`;
  }
  // The body is not read: drop it, so the connection closes.
  await response.body?.cancel();
  if (response.status !== 200) return `${check.url} answered HTTP ${response.status}`;
  const contentType = response.headers.get("content-type") ?? "";
  if (check.contentType && !contentType.startsWith(check.contentType)) {
    return `${check.url} answered ${contentType || "no content type"}, not ${check.contentType}`;
  }
  if (check.release) {
    const release = response.headers.get(RELEASE_HEADER);
    if (release !== check.release) return `${check.url} came from release ${release ?? "(none)"}, not ${check.release}`;
  }
  return null;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
