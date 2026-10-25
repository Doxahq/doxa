import { createRuntimeDocsArtifacts } from "@doxahq/docs-engine";
import type { ExampleDocsTemplate } from "@doxahq/contracts";
import type { Env } from "../../env";
import { DocsRepository } from "../../repositories/docs";
import { createR2DocsContentStore } from "../docs-content/store";
import { freePlanEntitlements } from "../free-plan-entitlements";
import { createExampleDocsPages, getExampleDocsNavigation } from "./template";

export interface ExampleDocsTarget {
  projectId: string;
  siteId: string;
  slug: string;
  name: string;
  /** Starter docs by default. */
  template?: ExampleDocsTemplate;
}

/**
 * Writes the example site (the starter docs or the empty site) to R2 and publishes it as the first version of a
 * project that has no repository. The version has no source revision, so it
 * is never a generation baseline: the first generation starts from scratch
 * and replaces the example.
 */
export async function publishExampleDocs(
  env: Env,
  project: ExampleDocsTarget,
) {
  const versionId = crypto.randomUUID();
  const bundle = await createRuntimeDocsArtifacts({
    siteId: project.siteId,
    versionId,
    projectSlug: project.slug,
    projectName: project.name,
    entitlements: await freePlanEntitlements.getProjectEntitlements(
      project.projectId,
    ),
    features: { apiPlayground: true },
    pages: createExampleDocsPages(project.name, project.template),
    navigation: getExampleDocsNavigation(project.template),
  });

  const writer = await createR2DocsContentStore(env.DOCS_BUCKET).openVersion({
    siteId: project.siteId,
    versionId,
  });
  for (const file of bundle.files) {
    await writer.put(file.path, file.content, file.contentType);
  }
  const { artifactPrefix, manifestPath } = await writer.commit();

  return new DocsRepository(env).publishSeedVersion({
    siteId: project.siteId,
    versionId,
    artifactPrefix,
    manifestPath,
  });
}
