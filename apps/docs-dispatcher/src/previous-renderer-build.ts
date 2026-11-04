/**
 * The deployed renderer build and the previous one, as the deploy wrote them
 * into the dispatcher vars (`scripts/lib/renderer-release-record.mjs`).
 */
export interface RendererBuild {
  buildId: string;
  releaseId: string;
}

export interface RendererBuildEnv {
  DOXA_RENDERER_BUILD_ID?: string;
  DOXA_RENDERER_RELEASE_ID?: string;
  DOXA_PREVIOUS_RENDERER_BUILD_ID?: string;
  DOXA_PREVIOUS_RENDERER_RELEASE_ID?: string;
  DOXA_RENDERER_DEPLOYED_AT?: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** The deployed build, or null when either value is missing. */
export function readCurrentRendererBuild(
  env: RendererBuildEnv,
): RendererBuild | null {
  const buildId = env.DOXA_RENDERER_BUILD_ID?.trim();
  const releaseId = env.DOXA_RENDERER_RELEASE_ID?.trim();
  return buildId && releaseId ? { buildId, releaseId } : null;
}

/**
 * The previous build, or null. Both IDs must be SHA-256 hex and both must
 * differ from the deployed ones: the deploy checks this too, and a reader
 * never treats the live build as "previous".
 */
export function readPreviousRendererBuild(
  env: RendererBuildEnv,
): RendererBuild | null {
  const buildId = env.DOXA_PREVIOUS_RENDERER_BUILD_ID?.trim() ?? "";
  const releaseId = env.DOXA_PREVIOUS_RENDERER_RELEASE_ID?.trim() ?? "";
  if (!SHA256_PATTERN.test(buildId) || !SHA256_PATTERN.test(releaseId)) {
    return null;
  }
  if (
    buildId === env.DOXA_RENDERER_BUILD_ID?.trim() ||
    releaseId === env.DOXA_RENDERER_RELEASE_ID?.trim()
  ) {
    return null;
  }
  return { buildId, releaseId };
}

/** When the deployed build went live (epoch ms), or null. */
export function readRendererDeployedAt(env: RendererBuildEnv): number | null {
  const value = env.DOXA_RENDERER_DEPLOYED_AT?.trim();
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}
