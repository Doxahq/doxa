import type {
  StoredBranchChange,
  StoredDocsBranch,
} from "../../repositories/docs-branches";
import type { EntitlementsService } from "../entitlements";
import type { SiteAssetStore } from "../site-assets/store";
import {
  readPublishedSiteConfig,
  validateConfigForSite,
} from "../docs-content/site-config";
import type { DocsContentStore } from "../docs-content/store";
import { EffectiveTree } from "./effective-tree";
import { createMaterializer, type MaterializeResult } from "./materialize";
import { SyncValidationError } from "./sync";
import { validateTree } from "./validate-tree";

export interface BranchMaterializationContext {
  projectId: string;
  projectName: string;
  siteId: string;
  branch: StoredDocsBranch;
  baseArtifactPrefix: string;
  changes: readonly StoredBranchChange[];
}

export async function materializeBranchArtifacts(
  deps: {
    store: DocsContentStore;
    entitlements: EntitlementsService;
    assets: Pick<SiteAssetStore, "head">;
  },
  input: BranchMaterializationContext & {
    targetVersionId: string;
    generatedAt: string;
  },
): Promise<MaterializeResult> {
  const tree = new EffectiveTree(
    deps.store,
    input.baseArtifactPrefix,
    input.changes,
  );
  const issues = await validateTree(tree);

  if (issues.some(({ severity }) => severity === "error")) {
    throw new SyncValidationError(issues);
  }

  const effective = await tree.content();
  const storedSiteConfig = await tree.read("settings/site.json");
  const siteConfigInput =
    storedSiteConfig === null
      ? await readPublishedSiteConfig(
          deps.store,
          {
            projectName: input.projectName,
            artifactPrefix: input.baseArtifactPrefix,
          },
          effective.manifest,
        )
      : JSON.parse(storedSiteConfig);
  const siteConfig = await validateConfigForSite(
    siteConfigInput,
    { projectId: input.projectId, siteId: input.siteId },
    deps.entitlements,
    deps.assets,
  );

  return createMaterializer({ store: deps.store })({
    siteId: input.siteId,
    base: {
      versionId: input.branch.baseVersionId,
      artifactPrefix: input.baseArtifactPrefix,
    },
    changes: input.changes,
    targetVersionId: input.targetVersionId,
    generatedAt: input.generatedAt,
    siteConfig,
  });
}
