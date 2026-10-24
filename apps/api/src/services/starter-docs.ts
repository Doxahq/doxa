import { createRuntimeDocsArtifacts } from "@doxahq/docs-engine";
import type { Env } from "../env";
import { DocsRepository } from "../repositories/docs";
import { JobsRepository } from "../repositories/jobs";
import { ProjectsRepository } from "../repositories/projects";
import { createR2DocsContentStore } from "./docs-content/store";
import { freePlanEntitlements } from "./free-plan-entitlements";

export async function publishStarterDocs(
  env: Env,
  input: { jobId: string; projectId: string },
) {
  const jobs = new JobsRepository(env);
  await jobs.markRunning(input.jobId);

  const project = await new ProjectsRepository(env).getInternal(
    input.projectId,
  );
  if (!project) {
    throw new Error("Project not found for starter docs generation.");
  }

  const versionId = crypto.randomUUID();
  const overviewContent = createOverviewPage(project.name);
  const gettingStartedContent = createGettingStartedPage(project.name);
  const bundle = await createRuntimeDocsArtifacts({
    siteId: project.siteId,
    versionId,
    projectSlug: project.slug,
    projectName: project.name,
    entitlements: await freePlanEntitlements.getProjectEntitlements(project.id),
    pages: [
      { title: project.name, route: "/", content: overviewContent },
      {
        title: "Getting Started",
        route: "/getting-started",
        content: gettingStartedContent,
      },
    ],
  });
  const writer = await createR2DocsContentStore(env.DOCS_BUCKET).openVersion({
    siteId: project.siteId,
    versionId,
  });
  for (const file of bundle.files) {
    await writer.put(file.path, file.content, file.contentType);
  }
  const { artifactPrefix, manifestPath } = await writer.commit();

  const version = await new DocsRepository(env).publishJob({
    jobId: input.jobId,
    artifactPrefix,
    manifestPath,
    reason: "starter_publication",
  });

  return version;
}

function createOverviewPage(projectName: string): string {
  return `---
title: ${projectName}
description: Generated documentation for ${projectName}
---

# ${projectName}

This is the first generated Doxa documentation version for ${projectName}.

## Local MVP Path

- The dashboard created a generation job.
- The API wrote versioned docs artifacts to R2.
- The docs runtime now serves this published version from the shared Worker.

## Next Step

Wire the Cloudflare container runner to replace this starter artifact with full repository-aware generation.
`;
}

function createGettingStartedPage(projectName: string): string {
  return `---
title: Getting Started
description: Start using ${projectName}
---

# Getting Started

Use this page as the first generated setup guide for ${projectName}.

## Install

\`\`\`bash
pnpm install
\`\`\`

## Generate Again

Trigger another generation from the Doxa dashboard after the agent container is wired to the selected repository.
`;
}
