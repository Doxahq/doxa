import type { DocsBranchPreviewResult } from "@doxahq/contracts/docs-branches";

import type { Env } from "../../env";
import {
  DocsBranchPreviewRepository,
  type DocsBranchPreviewStore,
} from "../../repositories/docs-branch-preview";
import { createDocsHostnameUrl } from "../../utils/docs-url";
import {
  createR2DocsContentStore,
  type DocsContentStore,
} from "../docs-content/store";
import type { EntitlementsService } from "../entitlements";
import { freePlanEntitlements } from "../free-plan-entitlements";
import {
  createR2SiteAssetStore,
  type SiteAssetStore,
} from "../site-assets/store";
import { materializeBranchArtifacts } from "./materialize-branch";

export class DocsBranchPreview {
  constructor(
    private readonly deps: {
      previews: DocsBranchPreviewStore;
      store: DocsContentStore;
      entitlements: EntitlementsService;
      assets: Pick<SiteAssetStore, "head">;
      docsBaseDomain: string | undefined;
      docsRendererBaseUrl: string | undefined;
      createVersionId?: () => string;
      now?: () => Date;
      materialize?: typeof materializeBranchArtifacts;
    },
  ) {}

  static fromEnv(env: Env): DocsBranchPreview {
    return new DocsBranchPreview({
      previews: new DocsBranchPreviewRepository(env),
      store: createR2DocsContentStore(env.DOCS_BUCKET),
      entitlements: freePlanEntitlements,
      assets: createR2SiteAssetStore(env.DOCS_BUCKET),
      docsBaseDomain: env.DOCS_BASE_DOMAIN,
      docsRendererBaseUrl: env.DOCS_RENDERER_BASE_URL,
    });
  }

  async build(input: {
    userId: string;
    projectId: string;
    branch: string;
  }): Promise<DocsBranchPreviewResult> {
    const versionId = this.deps.createVersionId?.() ?? crypto.randomUUID();
    const now = (this.deps.now ?? (() => new Date()))();
    const result = await this.deps.previews.build({
      ...input,
      versionId,
      docsBaseDomain: this.deps.docsBaseDomain,
      materialize: (context) =>
        (this.deps.materialize ?? materializeBranchArtifacts)(
          {
            store: this.deps.store,
            entitlements: this.deps.entitlements,
            assets: this.deps.assets,
          },
          {
            projectId: input.projectId,
            projectName: context.projectName,
            siteId: context.siteId,
            branch: context.branch,
            baseArtifactPrefix: context.baseArtifactPrefix,
            changes: context.changes,
            targetVersionId: versionId,
            generatedAt: now.toISOString(),
          },
        ),
    });

    return {
      ...result,
      url: createDocsHostnameUrl(result.hostname, {
        DOCS_RENDERER_BASE_URL: this.deps.docsRendererBaseUrl,
      }),
    };
  }
}
