import {
  isSiteInRollout,
  parseRolloutMode,
  type RolloutMode,
} from "./rollout-policy";

export type RendererSelection = "shared" | "dynamic";

interface RendererResolution {
  siteId: string;
  publishedVersionId: string;
  renderTarget?: "production" | "preview" | "generation_snapshot";
}

export function parseRendererMode(value: string | undefined): RolloutMode {
  return parseRolloutMode(value);
}

export function shouldResolveDocsHost(mode: RolloutMode): boolean {
  return mode !== "off";
}

export function getRendererSelection(input: {
  mode: RolloutMode;
  allowedSiteIds: ReadonlySet<string>;
  resolution: RendererResolution | null;
}): RendererSelection {
  if (input.resolution?.renderTarget !== "production") return "shared";
  return isSiteInRollout(
    { mode: input.mode, siteIds: input.allowedSiteIds },
    input.resolution.siteId,
  )
    ? "dynamic"
    : "shared";
}

/** One isolate per renderer build, shared by the sites of the shared-isolate rollout. */
export function createSharedRendererWorkerId(rendererBuildId: string): string {
  return ["docs", "build", rendererBuildId].join(":");
}

export function createDynamicWorkerId(input: {
  siteId: string;
  publishedVersionId: string;
  rendererBuildId: string;
}): string {
  return [
    "docs",
    input.siteId,
    input.publishedVersionId,
    input.rendererBuildId,
  ].join(":");
}
