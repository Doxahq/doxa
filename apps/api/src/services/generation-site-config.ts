import type { GenerationContext } from "@doxahq/contracts";
import { parseDocsManifestText, readSiteConfig } from "@doxahq/docs-engine";
import type { Env } from "../env";
import { DocsRepository } from "../repositories/docs";
import { planSeamsFromEnv } from "./billing/plan-seams";
import { createR2DocsContentStore } from "./docs-content/store";

/** The published version owns settings, not the incremental source baseline. */
export async function withGenerationSiteConfig<T extends GenerationContext>(
  env: Env,
  context: T | null,
): Promise<T | null> {
  if (!context) return null;
  const docs = new DocsRepository(env);
  const [resolution, entitlements, brandingEligible] = await Promise.all([
    docs.resolveByProjectId(context.project.id),
    planSeamsFromEnv(env).entitlements.getProjectEntitlements(context.project.id),
    docs.holdsOnlyStarterContent(context.project.id),
  ]);
  if (!resolution) return { ...context, entitlements, brandingEligible };
  if (
    resolution.siteId !== context.project.siteId ||
    resolution.projectId !== context.project.id
  ) {
    throw new Error("Published config resolved to a different project.");
  }
  const store = createR2DocsContentStore(env.DOCS_BUCKET);
  const manifestText = await store.read(resolution.manifestPath);
  if (manifestText === null)
    throw new Error("Published documentation manifest is missing.");
  const parsed = parseDocsManifestText(manifestText);
  if (!parsed.ok || parsed.manifest.siteId !== context.project.siteId) {
    throw new Error("Published documentation manifest is invalid.");
  }
  const config = await readSiteConfig(
    { read: (path) => store.readBytes(path) },
    {
      artifactPrefix: resolution.artifactPrefix,
      manifest: parsed.manifest,
      projectName: context.project.name,
    },
  );
  return { ...context, siteConfig: config, entitlements, brandingEligible };
}
