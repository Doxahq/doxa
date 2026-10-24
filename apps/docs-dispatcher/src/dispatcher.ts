import type { DocsDomainResolution } from "@doxahq/contracts";

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

  try {
    const response = await input.renderDynamic(input.request, resolution);
    if (response.status < 500 || !isSafeToReplay(input.request)) {
      return withRendererMode(response, "dynamic");
    }
  } catch (error) {
    if (!isSafeToReplay(input.request)) throw error;
  }

  return renderShared(input, "shared-fallback");
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
