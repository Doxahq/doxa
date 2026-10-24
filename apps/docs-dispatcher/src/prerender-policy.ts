import {
  createPrerenderIdentity,
  type PrerenderIdentity,
} from "@doxahq/contracts/docs-prerender";

import {
  isSiteInRollout,
  parseRolloutMode,
  type RolloutMode,
} from "./rollout-policy";

export function parsePrerenderMode(
  value: string | undefined,
  warn: (message: string) => void = console.warn,
): RolloutMode {
  return parseRolloutMode(value, (invalid) =>
    warn(
      `[doxa-docs-dispatcher] Invalid DOXA_PROD_PRERENDER_MODE ${JSON.stringify(invalid)}; pre-rendering is disabled.`,
    ),
  );
}

export function shouldUsePrerender(
  mode: RolloutMode,
  allowedSiteIds: ReadonlySet<string>,
  siteId: string,
): boolean {
  return isSiteInRollout({ mode, siteIds: allowedSiteIds }, siteId);
}

interface ExpectedPrerenderIdentityInput {
  siteId: string;
  artifactPrefix: string;
  manifestPath: string;
  rendererReleaseId: string;
  trustedRequestOrigin: string;
}

export async function createExpectedPrerenderIdentity(
  input: ExpectedPrerenderIdentityInput,
): Promise<PrerenderIdentity> {
  return createPrerenderIdentity({
    siteId: input.siteId,
    artifactPrefix: input.artifactPrefix,
    sourceManifestPath: input.manifestPath,
    rendererReleaseId: input.rendererReleaseId,
    trustedRequestOrigin: input.trustedRequestOrigin,
    effectivePublicOutputConfiguration: {},
  });
}
