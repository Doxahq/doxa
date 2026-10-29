import type { DocsDomainResolution } from "@doxahq/contracts";

import {
  isRendererPropsMissing,
  logRendererPropsMissing,
} from "./renderer-isolate";
import type { RolloutMode } from "./rollout-policy";
import { getRendererSelection, shouldResolveDocsHost } from "./routing-policy";

type RendererModeHeader = "dynamic" | "shared" | "shared-fallback";

export interface DocsDispatchInput {
  request: Request;
  mode: RolloutMode;
  allowedSiteIds: ReadonlySet<string>;
  resolveHost(hostname: string): Promise<DocsDomainResolution | null>;
  renderShared(request: Request): Promise<Response>;
  renderDynamic(
    request: Request,
    resolution: DocsDomainResolution,
  ): Promise<Response>;
}

export async function dispatchDocsRequest(
  input: DocsDispatchInput,
): Promise<Response> {
  if (!shouldResolveDocsHost(input.mode)) {
    return renderShared(input, "shared");
  }

  const resolution = await resolveHostOrNull(input);
  const selection = getRendererSelection({
    mode: input.mode,
    allowedSiteIds: input.allowedSiteIds,
    resolution,
  });
  if (selection === "shared" || !resolution) {
    return renderShared(input, "shared");
  }

  const replayable = isSafeToReplay(input.request);
  try {
    const response = await input.renderDynamic(input.request, resolution);
    if (response.status >= 500) {
      reportPropsMissing(response, resolution, replayable);
    }
    if (response.status < 500 || !replayable) {
      return withRendererMode(response, "dynamic");
    }
    // The failed body is never read, so the render log that waits for it
    // never runs: log the fallback here instead.
    await response.body?.cancel();
    logRendererFallback(input.request, resolution, {
      status: response.status,
    });
  } catch (error) {
    reportPropsMissing(error, resolution, replayable);
    if (!replayable) throw error;
    logRendererFallback(input.request, resolution, {
      error: describeFallbackError(error),
    });
  }

  return renderShared(input, "shared-fallback");
}

/** One line per request that the shared renderer answered after a failure. */
function logRendererFallback(
  request: Request,
  resolution: DocsDomainResolution,
  failure: { status: number } | { error: string },
): void {
  console.warn(
    JSON.stringify({
      event: "docs_renderer_fallback",
      siteId: resolution.siteId,
      publishedVersionId: resolution.publishedVersionId,
      path: new URL(request.url).pathname,
      ...failure,
    }),
  );
}

function describeFallbackError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, 300);
}

function reportPropsMissing(
  outcome: unknown,
  resolution: DocsDomainResolution,
  fallback: boolean,
): void {
  if (!isRendererPropsMissing(outcome)) return;
  logRendererPropsMissing({ entrypoint: "fetch", resolution, fallback });
}

async function resolveHostOrNull(
  input: DocsDispatchInput,
): Promise<DocsDomainResolution | null> {
  try {
    return await input.resolveHost(new URL(input.request.url).hostname);
  } catch {
    return null;
  }
}

async function renderShared(
  input: DocsDispatchInput,
  mode: Extract<RendererModeHeader, "shared" | "shared-fallback">,
): Promise<Response> {
  return withRendererMode(await input.renderShared(input.request), mode);
}

function isSafeToReplay(request: Request): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

function withRendererMode(
  response: Response,
  mode: RendererModeHeader,
): Response {
  const headers = new Headers(response.headers);
  headers.set("x-doxa-renderer-mode", mode);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
