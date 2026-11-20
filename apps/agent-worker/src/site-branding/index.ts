import type { GenerationContext, InternalApiRpc } from "@doxahq/contracts";
import type { SiteConfigInput } from "@doxahq/site-config";
import { applyDiscoveredBranding } from "./apply";
import { discoverBranding } from "./discover";
import type { Fetcher } from "./fetch";

export interface SiteBrandingEnv {
  API: InternalApiRpc;
  /** "0" turns the branding step off. On by default. */
  DOXA_SITE_BRANDING_ENABLED?: string;
  /** Context.dev runs only when this is true and the key is set. Off by default. */
  BRANDING_CONTEXT_DEV_ENABLED?: string;
  CONTEXT_DEV_API_KEY?: string;
}

/** The step result. `siteConfig` is null when the run keeps its settings. */
export interface SiteBrandingStepResult {
  siteConfig: SiteConfigInput | null;
}

export function isSiteBrandingEnabled(env: SiteBrandingEnv): boolean {
  return env.DOXA_SITE_BRANDING_ENABLED?.trim() !== "0";
}

export function contextDevApiKey(env: SiteBrandingEnv): string | null {
  const enabled = /^(?:1|true|yes|on)$/i.test(env.BRANDING_CONTEXT_DEV_ENABLED?.trim() ?? "");
  const key = env.CONTEXT_DEV_API_KEY?.trim();
  return enabled && key ? key : null;
}

/**
 * Fills the default branding of a site from its repository and homepage.
 * Runs only while the site holds starter content, so it never changes a
 * published site. It never fails the generation: any error keeps the
 * settings as they are.
 */
export async function runSiteBrandingStep(input: {
  env: SiteBrandingEnv;
  jobId: string;
  context: Pick<GenerationContext, "project" | "repository" | "siteConfig" | "brandingEligible">;
  fetch?: Fetcher;
}): Promise<SiteBrandingStepResult> {
  const { env, jobId, context } = input;
  if (context.brandingEligible !== true || !isSiteBrandingEnabled(env)) {
    return { siteConfig: null };
  }
  const contextDevKey = contextDevApiKey(env);
  try {
    const githubToken = await env.API.createRepositoryReadToken(context.project.id);
    const found = await discoverBranding({
      repositoryFullName: context.repository.fullName,
      fetch: input.fetch ?? ((request, init) => fetch(request, init)),
      githubToken,
      contextDevApiKey: contextDevKey,
      storeAsset: async (kind, bytes) =>
        (await env.API.storeGenerationSiteAsset({ jobId, kind, bytes })).ref,
    });
    if (!found) return { siteConfig: null };
    const { config, applied } = applyDiscoveredBranding(
      context.siteConfig,
      context.project.name,
      found,
    );
    await env.API.addJobEvent(jobId, {
      type: "site_branding_applied",
      message:
        applied.length > 0
          ? "Site branding filled from the repository and its homepage."
          : "No site branding found to fill.",
      source: "worker",
      data: {
        fields: applied,
        logoSource: found.logo?.source ?? null,
        colorSource: found.primaryColor?.source ?? null,
        homepage: found.homepage,
        contextDev: found.contextDev,
      },
    }).catch(() => undefined);
    return { siteConfig: applied.length > 0 ? config : null };
  } catch (error) {
    console.warn(JSON.stringify({
      event: "site_branding_failed",
      jobId,
      message: sanitize(error instanceof Error ? error.message : String(error), contextDevKey),
    }));
    return { siteConfig: null };
  }
}

function sanitize(message: string, secret: string | null): string {
  const clipped = message.slice(0, 300);
  return secret ? clipped.split(secret).join("[redacted]") : clipped;
}
