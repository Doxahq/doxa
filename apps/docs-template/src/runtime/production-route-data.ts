import {
  DOCS_PRERENDER_LIMITS,
  parsePublicRouteDataResponse,
  type PublicDocsRouteDataV1,
  type PublicRouteDataResponse,
} from "@doxahq/contracts/docs-prerender";

import type { DocsDeliveryCapability } from "./request-context";

const VERSION_RECOVERY_STORAGE_KEY = "doxa.docs.version-recovery";
const VERSION_RECOVERY_WINDOW_MS = 5 * 60_000;

interface LoadProductionRouteDataInput {
  pathname: string;
  capability: DocsDeliveryCapability;
  signal?: AbortSignal;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  liveFallback(
    pathname: string,
    expectedRenderId: string
  ): Promise<PublicRouteDataResponse>;
}

export async function loadProductionRouteData(
  input: LoadProductionRouteDataInput
): Promise<PublicDocsRouteDataV1> {
  const fetcher = input.fetcher ?? fetch;
  let response: Response;
  try {
    const query = new URLSearchParams({
      path: input.pathname,
      render: input.capability.renderId,
    });
    response = await fetcher(`/_doxa/route-data/v1?${query}`, {
      method: "GET",
      credentials: "omit",
      headers: { accept: "application/json" },
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    return loadLiveFallback(input);
  }

  if (response.status === 409) throw new DocsRenderVersionMismatchError();
  if (response.status === 404 || response.status === 503) {
    return loadLiveFallback(input);
  }
  if (!response.ok) {
    throw new Error(
      `The route-data endpoint returned HTTP ${response.status}.`
    );
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new Error(
      "The route-data endpoint returned an invalid content type."
    );
  }
  const result = parsePublicRouteDataResponse(
    await readBoundedJson(response, DOCS_PRERENDER_LIMITS.jsonBytes),
  );
  return unwrapRouteData(result, input.capability.renderId);
}

async function readBoundedJson(
  response: Response,
  limit: number,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel();
    throw new Error("The route-data response exceeds the size limit.");
  }
  if (!response.body) throw new Error("The route-data response has no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error("The route-data response exceeds the size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("The route-data endpoint returned invalid JSON.");
  }
}

async function loadLiveFallback(
  input: LoadProductionRouteDataInput
): Promise<PublicDocsRouteDataV1> {
  if (input.signal?.aborted) throw input.signal.reason;
  const result = parsePublicRouteDataResponse(
    await input.liveFallback(input.pathname, input.capability.renderId)
  );
  return unwrapRouteData(result, input.capability.renderId);
}

function unwrapRouteData(
  result: PublicRouteDataResponse,
  expectedRenderId: string
): PublicDocsRouteDataV1 {
  if (result.status === "version_mismatch") {
    throw new DocsRenderVersionMismatchError();
  }
  if (result.status === "unavailable") {
    throw new Error("Documentation route data is temporarily unavailable.");
  }
  if (result.renderId !== expectedRenderId) {
    throw new DocsRenderVersionMismatchError();
  }
  return result.data;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export class DocsRenderVersionMismatchError extends Error {
  constructor() {
    super("The documentation version changed during navigation.");
    this.name = "DocsRenderVersionMismatchError";
  }
}

interface VersionMismatchBrowser {
  currentHref: string;
  getMarker(): string | null;
  setMarker(value: string): void;
  assign(href: string): void;
  now(): number;
}

export function startVersionMismatchNavigation(
  input: { destinationHref: string; preload: boolean },
  browser: VersionMismatchBrowser = createVersionMismatchBrowser()
): boolean {
  if (input.preload) return false;
  const destination = new URL(input.destinationHref, browser.currentHref);
  const current = new URL(browser.currentHref);
  if (destination.origin !== current.origin) return false;

  const marker = parseVersionRecoveryMarker(browser.getMarker());
  const now = browser.now();
  if (
    marker?.href === destination.href &&
    now - marker.createdAt >= 0 &&
    now - marker.createdAt < VERSION_RECOVERY_WINDOW_MS
  ) {
    return false;
  }
  browser.setMarker(JSON.stringify({ href: destination.href, createdAt: now }));
  browser.assign(destination.href);
  return true;
}

function createVersionMismatchBrowser(): VersionMismatchBrowser {
  return {
    currentHref: window.location.href,
    getMarker: () =>
      window.sessionStorage.getItem(VERSION_RECOVERY_STORAGE_KEY),
    setMarker: (value) =>
      window.sessionStorage.setItem(VERSION_RECOVERY_STORAGE_KEY, value),
    assign: (href) => window.location.assign(href),
    now: () => Date.now(),
  };
}

function parseVersionRecoveryMarker(
  value: string | null
): { href: string; createdAt: number } | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "href" in parsed &&
      typeof parsed.href === "string" &&
      "createdAt" in parsed &&
      typeof parsed.createdAt === "number" &&
      Number.isFinite(parsed.createdAt)
    ) {
      return { href: parsed.href, createdAt: parsed.createdAt };
    }
  } catch {
    return null;
  }
  return null;
}
